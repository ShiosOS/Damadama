# Create and list habits evidence

Captured on 2026-10-12 at 21:09 UTC from local Aspire, persistent PostgreSQL, and the ordinary Clerk development UI.
The application checkout was `64377248b55b116ace09f4c506232e248408b7cb`.
Chromium used America/New_York, a 1440 by 900 desktop viewport, and a 390 by 844 mobile viewport.

- [Validation refusal](validation-error.png) shows the server's weekday error with the draft preserved.
- [Creation form](create-habit.png) shows the corrected weekday selection before retrying the save. The previous error remains visible until save succeeds.
- [Desktop saved list](saved-habits-desktop.png) shows the complete committed habit before reload.
- [Mobile saved list](saved-habits-mobile.png) shows the same values after reload. The full-page screenshot is taller than the viewport.
- [Screen recording](create-list-habits.mp4) shows development sign-in, validation refusal, corrected creation, immediate saved values, reload, and mobile display in 15.36 seconds.

The capture loaded previously saved habits, asserted HTTP 400 and draft preservation, then HTTP 201 and every definition and schedule value before reload.
It separately asserted the same values after reload, signed-out read refusal with HTTP 401, and zero browser page errors.
An independent PostgreSQL read confirmed the stored definitions, weekdays `[1, 4]`, three-week interval, timezone, creation date, and Monday anchor for habit `16134c7a-0580-4e80-bb10-f102e61f3dba`.
The persistent database recorded both the original migration and `20261012210223_GroupHabitLevels`.
Habit names remained non-interactive, with no separate detail view.

Sign-in used Clerk's reserved development account and verification code.
This verifies provider authentication and the real local browser-to-database flow.
It does not verify real email delivery or staging.
The recording contains no audio.
