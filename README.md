# nobeds-telegram

A Telegram bot that monitors NoBeds iCal booking exports and reports created,
changed, and cancelled bookings, and current room availability.

The bot is multi-tenant and self-service. Each chat registers its own iCal
export URL through the bot and receives notifications for that URL only. No
per-chat configuration is required in the environment, and a single deployment
can serve any number of properties.

## Contents

- [How it works](#how-it-works)
- [Feed format](#feed-format)
- [Installation](#installation)
- [Configuration](#configuration)
- [Commands](#commands)
- [Availability semantics](#availability-semantics)
- [Storage model](#storage-model)
- [Operational behaviour](#operational-behaviour)
- [Deployment](#deployment)
- [Development](#development)
- [Limitations](#limitations)

## How it works

NoBeds publishes bookings as an iCalendar export under `Channels → iCal Export`.
The URL is designed to be polled by external channel partners and requires no
authenticated session.

iCalendar is a state feed rather than an event stream: each response describes
all current bookings, not the changes since the last request. Booking events are
therefore derived by comparing each poll against the previous one. This makes
recovery automatic — a failed poll, a restart, or an extended outage does not
require replay, because the next successful poll observes the complete current
state.

## Feed format

The following structure was verified against a live export. Three properties of
it determine the implementation.

```
BEGIN:VEVENT
CLASS:PUBLIC
CREATED:20260726T190254Z
DESCRIPTION:CHECKIN:2026-07-26\nCHECKOUT:2026-07-29\nNIGHTS:3\nPROPERTY:A1 Room 2
DTEND;VALUE=DATE:20260729
DTSTAMP:20260726T190254Z
DTSTART;VALUE=DATE:20260726
LOCATION:12 04 Riverside Tower\, 8 Market St
SEQUENCE:0
SUMMARY:Mira Kovac
UID:427a870b-3946-433d-a5e7-e0ec6a9c33d1
END:VEVENT
```

**Field mapping.** `SUMMARY` contains the guest name. `LOCATION` contains the
guest's own address and is frequently empty. The room is not in `LOCATION`; it
is the `PROPERTY` key within `DESCRIPTION`.

**`DESCRIPTION` is structured.** It is a `KEY:value` block rather than free
text. Known keys (`CHECKIN`, `CHECKOUT`, `NIGHTS`, `PROPERTY`) are parsed into
fields; unrecognised keys are still rendered in notifications so that changes to
the feed remain visible.

**`UID` is not stable.** NoBeds generates a new random GUID for every booking on
every request, and sets `CREATED` and `DTSTAMP` to the time of the request.
Using `UID` as an identity would report every booking as cancelled and recreated
on every poll. Bookings are instead identified by room and check-in date, with a
secondary match on room and guest name so that a rescheduled stay is reported as
a modification rather than as a cancellation followed by a new booking. `UID`,
`DTSTAMP`, `CREATED`, and `SEQUENCE` are excluded from the change fingerprint.

The export sends neither `ETag` nor `Last-Modified`. Conditional requests are
implemented and will be used against feeds that support them, but do not take
effect against NoBeds.

Run `bun run inspect` to inspect a specific feed.

## Installation

Requires [Bun](https://bun.sh).

```bash
bun install
cp .env.example .env
```

Set `TELEGRAM_BOT_TOKEN` in `.env`, obtained from
[@BotFather](https://t.me/BotFather). No other variable is required.

```bash
bun start
```

Then, in Telegram:

1. Send `/start`. The bot requests an iCal export link.
2. Send the URL from `Channels → iCal Export`. The bot retrieves it once to
   verify that it is readable, reports the number of bookings and the rooms
   found, and begins monitoring.
3. Send `/availability` to view current availability.

Additional links may be sent at any time. The bot also operates in groups and
channels.

> **The iCal URL is a credential.** It grants read access to booking data for
> the lifetime of its token. In a group or channel it is visible to all members;
> a direct chat is preferable. The URL is masked in `/list` and `/status`
> output. If it is exposed, regenerate it in the NoBeds panel.

Registration is restricted to hosts on an allowlist (`nobeds.app` and
`nobeds.com` by default, configurable via `ALLOWED_ICAL_HOSTS`), which prevents
the bot from being used to retrieve arbitrary URLs.

### Pre-registering a feed

For single-tenant deployments, setting both `NOBEDS_ICAL_URL` and
`TELEGRAM_CHAT_ID` registers that pair at startup, without requiring interaction
in Telegram. Setting `NOBEDS_ICAL_URL` alone logs a warning and is otherwise
ignored.

### Inspecting a feed

```bash
bun run inspect                  # uses NOBEDS_ICAL_URL
bun run inspect <url>            # any iCal URL
bun run inspect ./saved.ics      # a local file
bun run inspect --raw            # additionally prints the raw response body
```

Reports which properties are present, how each booking is parsed, the exact
notification text that would be produced, and the `/availability` output. It
accesses neither the database nor Telegram and is safe to run against a
production feed.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | Required. Bot token from @BotFather. |
| `DB_PATH` | `./data/feeds.db` | Persistent store: registered iCal links. |
| `SNAPSHOT_PATH` | `/tmp/nobeds-snapshot.db` | Disposable store: last-poll bookings. |
| `POLL_INTERVAL_SECONDS` | `300` | Polling interval. Minimum 60. |
| `DISPLAY_TIMEZONE` | `Europe/Vilnius` | Timezone used to determine the current date. |
| `DISPLAY_LOCALE` | `en-GB` | Locale used to format dates. |
| `AVAILABILITY_DAYS` | `14` | Default window for `/availability`, in nights. |
| `CANCEL_GRACE_DAYS` | `2` | See [Operational behaviour](#operational-behaviour). |
| `FAILURE_ALERT_THRESHOLD` | `3` | Consecutive failures before an alert is sent. |
| `MAX_FEEDS_PER_CHAT` | `10` | Maximum links a single chat may register. |
| `ALLOWED_ICAL_HOSTS` | `nobeds.app,nobeds.com` | Hosts eligible for registration. |
| `NOTIFY_ON_FIRST_RUN` | `false` | Announce existing bookings when a link is first registered. |
| `NOBEDS_ICAL_URL` | — | Optional. See [Pre-registering a feed](#pre-registering-a-feed). |
| `TELEGRAM_CHAT_ID` | — | Optional. Used only with `NOBEDS_ICAL_URL`. |

## Commands

| Command | Description |
| --- | --- |
| `/start` | Register an iCal link |
| `/add [url]` | Register an additional link |
| `/list` | List the links registered by this chat |
| `/remove <n>`, `/remove all` | Deregister a link, or all links |
| `/availability [days]` | Availability over the given window |
| `/upcoming [n]` | Forthcoming arrivals |
| `/poll`, `/refresh` | Retrieve the feeds immediately |
| `/status` | Feed health, failure counts, and token expiry |
| `/chatid` | Report the current chat ID |
| `/help` | List available commands |

Each command operates only on the links registered by the chat that issued it.
No ownership check is required, because a chat cannot address any link it did
not register itself.

`/poll` retrieves the feeds without waiting for the next scheduled interval and
replies with a summary; any booking change is reported beforehand in the usual
notification format. It is subject to a 30-second per-chat cooldown, and it
runs on the same queue as the scheduled poll, so a manual and a scheduled
retrieval cannot overlap and duplicate notifications.

## Availability semantics

Rooms are derived from bookings. The export lists bookings only and does not
publish room inventory, so a room that has never been booked cannot appear in
the output; the response states this explicitly.

A stay occupies the nights in the half-open interval `[check-in, check-out)`.
The room is therefore available again on the checkout date, and a same-day
turnaround is reported correctly rather than as a gap.

## Storage model

Two SQLite databases are used, with deliberately different lifetimes.

| | `DB_PATH` | `SNAPSHOT_PATH` |
| --- | --- | --- |
| Contents | registered links: chat ID, URL, registration time | last-poll bookings and per-feed polling state |
| Guest data | none | guest names, addresses, stay dates |
| Lifetime | persistent; include in backups | disposable; excluded from backups |

Booking data is persisted for one purpose: deriving created, changed, and
cancelled events requires comparing the current poll with the previous one. That
comparison is its only consumer. All other output is sent to Telegram and not
retained.

Consequences:

- **Loss of the snapshot is a supported condition.** The next poll re-seeds
  silently rather than reporting existing bookings as new. The cost is that
  changes occurring while the process was stopped are not reported. This
  behaviour is covered by a test.
- **`/availability` and `/upcoming` do not read the snapshot.** Both retrieve
  the feed directly, so they remain accurate before the first poll and after the
  snapshot has been cleared, and answering them writes nothing to disk.
- **`/remove` discards the cached bookings** in addition to the link.
- On Ubuntu, `/tmp` is a tmpfs and is cleared on reboot.
  `systemd-tmpfiles-clean.timer` additionally removes files untouched for ten
  days, which does not apply here because the snapshot is rewritten each poll.

## Operational behaviour

- **Token expiry is monitored.** The URL embeds a JWT, typically valid for one
  year, signed by NoBeds and not renewable by this application. Its `exp` claim
  is decoded and reported at 30 days, daily under 7 days, and after expiry.
  `/status` displays the expiry date at all times.
- **A booking absent from the feed is not necessarily cancelled.** If the export
  covers a rolling window, past bookings are removed from it in the normal
  course. A booking whose checkout preceded the current time by more than
  `CANCEL_GRACE_DAYS` is treated as having aged out and is not reported.
- **An empty response is not treated as a mass cancellation.** A well-formed
  response containing no events, received while bookings are being tracked, is
  treated as an error condition: the snapshot is retained and a single warning
  is issued.
- **A non-iCalendar response is a failure.** An error page or login redirect
  raises an error rather than clearing the snapshot.
- **The snapshot advances only after all notifications have been sent.** If
  Telegram is unavailable, the next poll repeats the same comparison. A
  duplicate notification is recoverable; an unreported booking is not.
- **Guest data is never written to the persistent volume.** See
  [Storage model](#storage-model).
- **Links are verified before registration.** A URL that cannot be retrieved and
  parsed is rejected at the point of registration, with the error reported.
- **Unreachable chats are deactivated.** If the bot is blocked or removed, the
  associated feeds are disabled rather than polled indefinitely.
- **Dates render in UTC; the current date resolves in the configured
  timezone.** Stay dates carry no time component, so rendering them in a
  negative-offset timezone would display the preceding day. Availability queries
  resolve "today" in `DISPLAY_TIMEZONE`.
- **Repeated failures are reported.** Consecutive retrieval failures raise an
  alert at `FAILURE_ALERT_THRESHOLD`, then every twelfth failure thereafter, and
  once more on recovery.

## Deployment

Any host capable of running the process continuously. Under systemd:

```ini
[Unit]
Description=NoBeds Telegram notifier
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/nobeds-telegram
EnvironmentFile=/opt/nobeds-telegram/.env
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Under Docker:

```bash
docker build -t nobeds-telegram .
docker run -d --env-file .env -v nobeds-data:/app/data nobeds-telegram
```

Under pm2, using the supplied `ecosystem.config.cjs`:

```bash
pm2 startOrRestart ecosystem.config.cjs --update-env && pm2 save
```

`deploy.sh` performs a complete deployment to a remote host: it runs the type
check and test suite, synchronises the source tree, installs dependencies, and
restarts the pm2 process. It does not modify the remote `data/` directory or
`.env` unless `--with-env` is given.

The target is read from `.env` (which is not committed) or from the
environment, so the repository contains no hostname or server paths:

```bash
DEPLOY_HOST=user@host
DEPLOY_DIR=/srv/nobeds-telegram
DEPLOY_BUN=/usr/local/bin/bun    # optional
```

```bash
./deploy.sh                 # verify, synchronise, restart
./deploy.sh --with-env      # additionally upload .env
./deploy.sh --skip-checks   # skip the type check and tests
./deploy.sh --logs          # tail logs after deployment
```

The process must run as a single instance. Two processes would poll the same bot
token, which Telegram rejects with a conflict, and would write the same
databases.

`DB_PATH` must be located on persistent storage; its loss requires every chat to
register its links again. `SNAPSHOT_PATH` is expected to be lost and should not
be backed up.

## Development

```bash
bun test
bun run typecheck
bun run dev       # watch mode
```

The suite comprises 129 tests.

- `test/bot.test.ts` exercises the Telegram handlers through grammy using
  synthetic updates, with outgoing API calls intercepted: registration,
  rejection of unlisted hosts and unreadable feeds, per-chat isolation, and
  deregistration.
- `test/poller.test.ts` runs the complete poll cycle against a local feed
  server: seeding, creation, cancellation, the empty-response guard, conditional
  requests, failure alerting, concurrent chats, and retention of the snapshot
  when a notification fails to send.
- `test/fixtures/nobeds.ics` reproduces the structure of a live export,
  including CRLF line endings and a folded line within a property value. Guest
  names and addresses are fictional.

## Limitations

- The export contains no pricing and may contain no guest contact details.
- Availability cannot account for rooms that have never been booked.
- Feeds are polled serially within a single process. This is appropriate for
  tens of links; a substantially larger deployment would require concurrent
  polling and per-feed scheduling.

## License

MIT — see [LICENSE](LICENSE).
