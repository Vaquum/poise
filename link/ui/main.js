// The pairing and status window. Rust owns all state; this page renders the
// status events it sends and forwards the person's choices as commands.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const sections = ['signed-out', 'pairing', 'paired'];

function show(id) {
  for (const section of sections) $(section).hidden = section !== id;
}

function setMessage(element, text) {
  element.textContent = text ?? '';
  element.hidden = !text;
}

function report(error) {
  setMessage($('error'), String(error));
}

function render(view) {
  const connection = view.connection;
  setMessage($('error'), null);
  if (connection.state === 'signedOut') {
    show('signed-out');
    if (view.server && !$('server').value) $('server').value = view.server;
    setMessage($('signed-out-reason'), connection.reason);
  } else if (connection.state === 'pairing') {
    show('pairing');
    $('user-code').textContent = connection.userCode ?? '…';
    $('pairing-hint').textContent = connection.verificationUri
      ? `Your browser opened ${connection.verificationUri}. Sign in if asked, check that it shows this code, and approve.`
      : 'Asking Poise for a code…';
    $('reopen').disabled = !connection.verificationUri;
  } else {
    show('paired');
    $('login').textContent = view.login ?? '';
    $('endpoint').textContent = view.endpoint ?? '';
    $('connection-line').textContent = view.connectionLine;
    $('snippets-line').textContent = view.snippetsLine;
    const snippets = view.snippets;
    setMessage(
      $('paired-detail'),
      connection.error ??
        snippets.detail ??
        snippets.reason ??
        snippets.error ??
        (snippets.state === 'synced' ? `Espanso reads them from ${snippets.file}` : null),
    );
  }
}

$('pair-form').addEventListener('submit', (event) => {
  event.preventDefault();
  setMessage($('error'), null);
  invoke('pair', { server: $('server').value }).catch(report);
});
$('cancel').addEventListener('click', () => invoke('cancel_pairing').catch(report));
$('reopen').addEventListener('click', () => invoke('open_verification').catch(report));
$('open-poise').addEventListener('click', () => invoke('open_poise').catch(report));

listen('status', (event) => render(event.payload));
invoke('status').then(render, report);
