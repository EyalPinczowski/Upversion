# 014 – Calendar token encryption and write guard

**Status:** Accepted · calendar feature (v0.3b). Builds on ADR 002 (scopes and write guard) and ADR 006 (OAuth production status).

## Context
Calendar sync stores a long-lived Google refresh token and writes to a user's real calendar. A leaked token or a write to the wrong event would destroy trust. The details below were not fixed by ADR 002 and 006.

## Decision
- **Token encryption.** Refresh tokens are encrypted with AES-256-GCM before they reach the database. The user id and the key id are bound in as associated data, so a ciphertext copied to another user or relabelled with another key id fails to decrypt. Tokens are decrypted only in the backend and never sent to the browser.
- **Key rotation.** `CALENDAR_TOKEN_KEYS` holds keys as `<id>:<base64 of 32 bytes>`, comma separated, newest first. New tokens use the first key; older keys stay to decrypt existing tokens. With `FEATURE_CALENDAR=true` the API refuses to start without a valid key.
- **Branded write guard.** Only one code path can write to Google Calendar. It accepts a branded type that can be produced only by checking that the event is in the app's own secondary calendar and carries the app's `extendedProperties.private` tag. Any other target throws. This sits above the `CalendarProvider` interface.
- **Deterministic event ids.** Each study block maps to one event id derived from the block, so a retried request or a lost response never creates a duplicate.
- **Fixed neutral source tag.** The tag value (`APP_EVENT_SOURCE`) is a constant that does not depend on the product name, so a rename never orphans existing events.
- **Disconnect and account delete remove events only.** The app deletes the events it created and the calendar data and token it stores. It never deletes the secondary calendar itself or anything else in the user's Google account.
- **User-deleted blocks mean unavailable time.** If the user deletes a study block in Google Calendar, the app treats that slot as time the user does not want to study, and reschedules around it instead of recreating the event. (Relies on Google keeping `extendedProperties` and the etag on a deleted event: **needs check**, see `docs/google-calendar-setup.md`.)
- **Busy source.** The primary calendar is the default busy source; other calendars are opt-in.
- **No calendar data in AI prompts.** Event titles and times must be excluded from every AI prompt (project rule: no personal details are sent to AI models). A test must enforce this when AI context building touches the calendar.
- **One plan at a time.** Only the newest created active plan is written to the app calendar. Events of any other plan (for example a demo plan next to the real one) are removed from the app calendar, through the write guard and only the ones the app created, and stay removed until that plan is the newest active plan again. This keeps two plans from overlapping in Google. The NEWEST created active plan is the one written, so a demo plan created after the real one would win: delete or archive it. Past events stay as history.
- **Time zones in the busy view.** Calendar rows (busy, tentative, all-day) are always in the newest active plan's time zone, because that is how the sync splits them; deleted-block slots use the zone of the plan being shown, so with two active plans in different zones the two kinds can differ in one grid.
- **Readable events.** The title is `<Type>: <task title>` and the description holds only the owner's own plan data (plan name, type, estimate, the task link, the how-to steps), capped in length, with no AI text. Colours (Google only has 11) belong to a course or exam, not to a task: tasks that share an `externalRef` share a colour, practice, admin and CV tasks are graphite. The row keeps `last_color`, `last_summary` and a hash of the description (`last_detail_hash`) so a change is patched once.
- **Separate Google Cloud project.** Calendar uses its own Google Cloud project and OAuth client, apart from the sign-in client, so the sensitive scopes and any future verification do not affect sign-in.

## Consequences
- A tampered or mis-keyed ciphertext fails closed, and the user sees "Reconnect calendar".
- Rotating a key needs no downtime or re-encryption; old keys can be removed once no token uses them.
- Tests must prove that a write to a foreign event throws and that ciphertexts do not decrypt for another user id or key id.
- Google behaviours this relies on are listed as smoke tests in `docs/google-calendar-setup.md`.
