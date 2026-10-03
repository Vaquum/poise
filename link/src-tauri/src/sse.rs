//! A Server-Sent Events parser for the workspace's event stream.
//!
//! It follows the WHATWG rules for interpreting an event stream: lines end in
//! CRLF, LF or CR; `:` starts a comment; a blank line dispatches the event that
//! the `event`, `data`, `id` and `retry` fields before it built up.

use std::time::Duration;

/// The largest event (or unterminated line) the parser buffers before giving
/// up on the stream. The workspace's events are a few hundred bytes.
pub const MAX_EVENT_BYTES: usize = 1024 * 1024;

/// One dispatched event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    /// The event type; `message` when the stream named none.
    pub event: String,
    /// The `data` lines, joined with `\n`.
    pub data: String,
    /// The `id` field given in this event's own block, if any.
    pub id: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SseError {
    #[error("an event on the stream exceeded {MAX_EVENT_BYTES} bytes")]
    TooLarge,
}

/// Incremental parser: feed it the stream's bytes as they arrive.
#[derive(Debug, Default)]
pub struct Parser {
    line: Vec<u8>,
    // The previous chunk ended in CR, so a leading LF in the next one belongs to it.
    after_cr: bool,
    started: bool,
    event: String,
    data: String,
    id: Option<String>,
    retry: Option<Duration>,
}

impl Parser {
    pub fn new() -> Self {
        Self::default()
    }

    /// The reconnection time the server last asked for with `retry:`.
    pub fn retry(&self) -> Option<Duration> {
        self.retry
    }

    /// Parses `chunk` and returns the events it completed.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<Event>, SseError> {
        let mut events = Vec::new();
        let mut rest = chunk;
        if self.after_cr {
            self.after_cr = false;
            if let Some(stripped) = rest.strip_prefix(b"\n") {
                rest = stripped;
            }
        }
        while let Some(end) = rest.iter().position(|&b| b == b'\n' || b == b'\r') {
            self.line.extend_from_slice(&rest[..end]);
            let terminator = rest[end];
            rest = &rest[end + 1..];
            if terminator == b'\r' {
                match rest.first() {
                    Some(b'\n') => rest = &rest[1..],
                    None => self.after_cr = true,
                    Some(_) => {}
                }
            }
            let line = std::mem::take(&mut self.line);
            if let Some(event) = self.process_line(&line) {
                events.push(event);
            }
            self.check_size()?;
        }
        self.line.extend_from_slice(rest);
        self.check_size()?;
        Ok(events)
    }

    fn check_size(&self) -> Result<(), SseError> {
        if self.line.len() + self.data.len() > MAX_EVENT_BYTES {
            return Err(SseError::TooLarge);
        }
        Ok(())
    }

    fn process_line(&mut self, raw: &[u8]) -> Option<Event> {
        let decoded = String::from_utf8_lossy(raw);
        let mut line: &str = &decoded;
        if !self.started {
            self.started = true;
            line = line.strip_prefix('\u{feff}').unwrap_or(line);
        }
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = value.to_owned(),
            "data" => {
                self.data.push_str(value);
                self.data.push('\n');
            }
            "id" if !value.contains('\0') => self.id = Some(value.to_owned()),
            "retry" if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
                if let Ok(millis) = value.parse::<u64>() {
                    self.retry = Some(Duration::from_millis(millis));
                }
            }
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<Event> {
        let id = self.id.take();
        let event = std::mem::take(&mut self.event);
        if self.data.is_empty() {
            return None;
        }
        let mut data = std::mem::take(&mut self.data);
        data.pop();
        Some(Event {
            event: if event.is_empty() {
                "message".to_owned()
            } else {
                event
            },
            data,
            id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_all(input: &str) -> Vec<Event> {
        Parser::new().feed(input.as_bytes()).unwrap()
    }

    fn event(event: &str, data: &str, id: Option<&str>) -> Event {
        Event {
            event: event.to_owned(),
            data: data.to_owned(),
            id: id.map(str::to_owned),
        }
    }

    #[test]
    fn reads_event_data_and_id() {
        let events = parse_all("id: a1\nevent: alert\ndata: {\"id\":\"a1\"}\n\n");
        assert_eq!(events, vec![event("alert", "{\"id\":\"a1\"}", Some("a1"))]);
    }

    #[test]
    fn event_type_defaults_to_message() {
        assert_eq!(
            parse_all("data: hi\n\n"),
            vec![event("message", "hi", None)]
        );
    }

    #[test]
    fn joins_multi_line_data_with_newlines() {
        let events = parse_all("event: snippets\ndata: one\ndata: two\ndata:\ndata: four\n\n");
        assert_eq!(events, vec![event("snippets", "one\ntwo\n\nfour", None)]);
    }

    #[test]
    fn ignores_comments() {
        let events = parse_all(": keepalive\n:\ndata: x\n: between fields\n\n");
        assert_eq!(events, vec![event("message", "x", None)]);
    }

    #[test]
    fn reads_retry_and_ignores_invalid_values() {
        let mut parser = Parser::new();
        assert_eq!(parser.feed(b"retry: 3000\n\n").unwrap(), vec![]);
        assert_eq!(parser.retry(), Some(Duration::from_millis(3000)));
        parser
            .feed(b"retry: 1s\nretry: -5\nretry:\nretry: 12 \n\n")
            .unwrap();
        assert_eq!(parser.retry(), Some(Duration::from_millis(3000)));
    }

    #[test]
    fn accepts_crlf_and_cr_line_endings() {
        let events = parse_all("event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\r");
        assert_eq!(events, vec![event("a", "1", None), event("b", "2", None)]);
    }

    #[test]
    fn crlf_split_across_chunks_is_one_line_end() {
        let mut parser = Parser::new();
        assert_eq!(parser.feed(b"data: x\r").unwrap(), vec![]);
        // Without remembering the CR, this LF would read as a blank line and dispatch early.
        assert_eq!(parser.feed(b"\ndata: y\r").unwrap(), vec![]);
        assert_eq!(
            parser.feed(b"\n\r\n").unwrap(),
            vec![event("message", "x\ny", None)]
        );
    }

    #[test]
    fn same_events_when_fed_one_byte_at_a_time() {
        let input = "id: 7\nevent: alert\ndata: a\ndata: b\n\n: ping\nevent: ping\ndata: {}\n\n";
        let mut parser = Parser::new();
        let mut events = Vec::new();
        for byte in input.as_bytes() {
            events.extend(parser.feed(std::slice::from_ref(byte)).unwrap());
        }
        assert_eq!(events, parse_all(input));
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn field_without_colon_has_empty_value() {
        assert_eq!(parse_all("data\n\n"), vec![event("message", "", None)]);
    }

    #[test]
    fn strips_only_one_leading_space() {
        assert_eq!(
            parse_all("data:  two spaces\n\n"),
            vec![event("message", " two spaces", None)]
        );
        assert_eq!(
            parse_all("data:none\n\n"),
            vec![event("message", "none", None)]
        );
    }

    #[test]
    fn id_with_null_is_ignored_and_id_is_per_event() {
        let events = parse_all("id: a\u{0}b\ndata: 1\n\ndata: 2\n\nid:\ndata: 3\n\n");
        assert_eq!(
            events,
            vec![
                event("message", "1", None),
                event("message", "2", None),
                event("message", "3", Some("")),
            ]
        );
    }

    #[test]
    fn blank_line_without_data_dispatches_nothing_and_resets_type() {
        let events = parse_all("event: alert\n\ndata: later\n\n");
        assert_eq!(events, vec![event("message", "later", None)]);
    }

    #[test]
    fn strips_a_leading_byte_order_mark() {
        assert_eq!(
            parse_all("\u{feff}event: a\ndata: 1\n\n"),
            vec![event("a", "1", None)]
        );
    }

    #[test]
    fn unterminated_event_is_not_dispatched() {
        assert_eq!(parse_all("event: alert\ndata: never finished\n"), vec![]);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        assert_eq!(
            parse_all("foo: bar\ndata: 1\n\n"),
            vec![event("message", "1", None)]
        );
    }

    #[test]
    fn refuses_an_oversized_event() {
        let mut parser = Parser::new();
        let line = format!("data: {}\n", "x".repeat(MAX_EVENT_BYTES / 2));
        parser.feed(line.as_bytes()).unwrap();
        assert_eq!(parser.feed(line.as_bytes()), Err(SseError::TooLarge));

        let mut unterminated = Parser::new();
        let endless = vec![b'x'; MAX_EVENT_BYTES + 1];
        assert_eq!(unterminated.feed(&endless), Err(SseError::TooLarge));
    }
}
