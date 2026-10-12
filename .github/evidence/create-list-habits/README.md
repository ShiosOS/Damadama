# Create and list habits evidence

Recorded on 2026-10-12 at 22:20 UTC from local Aspire, persistent PostgreSQL, and the ordinary Clerk development UI. Form screenshots were recaptured afterward at the same application revision.
The application checkout was `503f6363f079a4940bdf3ea80ad0a5e67f468226`.
Chromium used America/New_York, a 1440 by 900 desktop viewport, and a 390 by 844 mobile viewport.
Form screenshots show the viewport; saved-list screenshots show the full page.

- [Validation refusal](validation-error.png) shows the server's weekday error with the draft preserved.
- [Creation form](create-habit.png) shows the corrected weekday selection before retrying the save. The previous error remains visible until save succeeds.
- [Desktop saved list](saved-habits-desktop.png) shows the committed definitions, selected weekdays, and repeat interval before reload, with both calendar subtitles absent.
- [Mobile saved list](saved-habits-mobile.png) shows the same values after reload. The full-page screenshot is taller than the viewport.
- [Screen recording](create-list-habits.mp4) shows development sign-in, validation refusal, corrected creation, reload, and the saved result on mobile in 12.56 seconds. The full-page desktop screenshot and assertions provide the before-reload evidence; the new row sits below the desktop recording's viewport.

The capture loaded previously saved habits, asserted HTTP 400 and draft preservation, then HTTP 201 and each definition, weekday, and repeat interval before reload.
It separately asserted the same visible values after reload and on mobile, absence of both subtitles, signed-out read refusal with HTTP 401, and zero browser page errors.
Definitions and the complete schedule, including timezone, creation date, and Monday anchor, matched exactly in the create and reload API responses. The creation timestamp matched to millisecond precision.
An independent PostgreSQL read confirmed the stored definitions, weekdays `[1, 5]`, two-week interval, America/New_York, creation date 2026-10-12, and Monday anchor 2026-10-12 for habit `6d8ca194-5a67-4cff-8b47-bd2472c5348e`.
The calendar metadata remains stored and returned by the API, while the list displays the definitions, selected weekdays, and repeat interval.
Habit names remained non-interactive, with no separate detail view.

Sign-in used Clerk's reserved development account and verification code.
This verifies provider authentication and the real local browser-to-database flow.
It does not verify real email delivery or staging.
The recording contains no audio.
