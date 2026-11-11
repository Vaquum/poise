# Menu and Settings

The top bar is fixed: Overview, Board, Chat, Editor, Observe and Settings, in
that order ([Interface](Interface.md)). Settings opens a menu under it: *Style
panel*, *Manager's controls* (Rhythm, Stability and Autonomy, in the Manager
place), then the ten sections of Settings: General, Accounts, Models,
Extensions, Publishing, Behaviors, Snippets, Admin, Style and Manager. Each
opens Settings at that section's address, `?view=settings&settings=<section>`,
with a route back to the place you came from. Admin opens only where it is
allowed, as before. Escape closes the menu and returns focus to Settings.

Settings is a place, not an overlay: each section has its own address, and Find
searches every setting. Each setting saves itself on its row, sending only its
own field, says when it applies, and keeps its row in the editing state, with
the reason, when it cannot be saved. Analytics is part of Overview, Logging is
Observe → Logging, and Extensions and Snippets are sections of Settings.
Navigation and Theme are gone: the top bar is fixed and the interface is dark.

General holds GitHub identities, accounts to follow, time, notifications and
chat defaults. Models holds the three models and each place's model. Accounts
separates AI provider sign-ins from GitHub sign-ins, with Poise Link in service
mode and a workspace terminal. Publishing lists the websites the Editor
publishes to (see [Publishing](Publishing.md)). Style holds the type, scale,
shape, motion and meaning colours the Style panel holds, and the writing ones.

Explanations appear after half a second over any element, and on keyboard
focus; `?` opens the full reference ([Interface](Interface.md#the-reference)).
Errors, account state and pairing instructions remain visible. Existing account,
pairing and admin links open their destination directly.

The previous interface, at `/classic.html` until it is removed, keeps its burger
menu, Navigation and Typography as they were.
