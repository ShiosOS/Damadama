# Create and list habits evidence

Captured on 2026-10-12 at 20:29 UTC from local Aspire, persistent PostgreSQL, and the ordinary Clerk development UI.
The checkout was `97e0a6e`; application code was unchanged from `2075d7b`.
Chromium used America/New_York, a 1440 by 900 desktop viewport, and a 390 by 844 mobile viewport.

- [Creation form](create-habit.png) shows the three definitions, selected weekdays, and repeat interval before save.
- [Desktop saved list](saved-habits-desktop.png) shows the complete committed habit before reload.
- [Mobile saved list](saved-habits-mobile.png) shows the same values in a fresh signed-in browser. The full-page screenshot is taller than the viewport.
- [Screen recording](create-list-habits.mp4) shows development sign-in, creation, immediate saved values, reload, and mobile display in 15.72 seconds.

The capture asserted HTTP 201, every definition and schedule value before reload, the same values after reload, and zero browser page errors.
Creation preserved 2026-10-12 in America/New_York and the first repeat week's Monday anchor, 2026-10-12.
Habit names remained non-interactive, with no separate detail view.

Sign-in used Clerk's reserved development account and verification code.
This verifies provider authentication and the real local browser-to-database flow.
It does not verify real email delivery or staging.
The recording contains no audio.
