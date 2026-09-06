# URL Notifications (Capture) - EARS

**Parent LLD**: ./LLD.md

## Capture Trigger

- [x] **URL-TRG-001**: When a main-session turn ends via
  `session.execution.succeeded` or `session.execution.failed` and
  `include_urls` is enabled, the system shall fetch the session's messages
  over the server HTTP API (discovered from the opencode `service.json`)
  and extract URLs from the newest assistant message that has visible
  text content.
- [x] **URL-TRG-002**: While `include_urls` is disabled, the system shall
  not fetch messages for URL capture.
- [x] **URL-TRG-003**: The system shall run URL capture only after the
  existing per-session dedupe and subagent gates pass, so capture shall
  never cause an additional push.

## Extraction

- [x] **URL-EXT-001**: The system shall extract URLs whose scheme is
  `http://` or `https://` from the final assistant message's text content.
- [x] **URL-EXT-002**: The system shall strip trailing punctuation
  (`. , ; : ! ?` space and quotes) from extracted URLs.
- [x] **URL-EXT-003**: The system shall treat a parenthesized segment as
  part of a URL only when the paren closes inside the URL (balanced), so
  markdown links like `[text](http://a)` do not gain a trailing `)`.
- [x] **URL-EXT-004**: The system shall deduplicate extracted URLs,
  preserving first-seen order.
- [x] **URL-EXT-005**: The system shall include at most `max_urls` URLs
  (default 3) in one notification.

## Notification Presentation

- [x] **URL-PRS-001**: When one or more URLs are captured, the system
  shall append each URL on its own line to the notification body, after
  the existing directory and error text.
- [x] **URL-PRS-002**: The system shall set the Bark push's `url` field to
  the first captured URL whose host is not `localhost`, `127.0.0.1`,
  `::1`, or `[::1]`, falling back to the first captured URL.
- [x] **URL-PRS-003**: The system shall set the ntfy push's `Click` header
  using the same selection rule as URL-PRS-002.
- [x] **URL-PRS-004**: Where no URL is captured, the system shall send the
  notification without a tap-through target (no Bark `url` field, no ntfy
  `Click` header).

## Failure and Degradation

- [x] **URL-FAIL-001**: If the messages fetch throws or returns a non-2xx
  status, then the system shall log the failure and send the notification
  without URLs.
- [x] **URL-FAIL-002**: If the messages response contains no assistant
  message or no text content, then the system shall send the notification
  without URLs.
- [x] **URL-FAIL-003**: If the messages response is empty, then the system
  shall retry once after 250 ms before giving up.
- [x] **URL-FAIL-004**: If the opencode service discovery file
  (`service.json`) is missing or unreadable, then the system shall send
  the notification without URLs.

## Configuration

- [x] **URL-CFG-001**: The system shall read `include_urls` (default
  `true`) and `max_urls` (default `3`) with the existing precedence:
  plugin options > environment > config file > defaults.
- [x] **URL-CFG-002**: The system shall clamp `max_urls` to the range
  1-10.

## Related Documents

- [URL Notifications LLD](./LLD.md)
