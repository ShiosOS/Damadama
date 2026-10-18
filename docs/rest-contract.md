# REST application contract

The application uses the [Siren representation format](https://github.com/kevinswiber/siren) and [RFC 9457 problems](https://www.rfc-editor.org/rfc/rfc9457.html). The Check job runs the behavioral contract tests as part of `bun run check`. This is an enforceable application profile, not a universal certification of REST architecture.

## Discovery and representations

`/api/config` is the browser's sole built-in application URI. Its Siren `properties` contain the Clerk publishable key; its links and actions advertise every starting operation. `self` identifies the represented resource and `profile` points to the served protocol description. The extension relation `https://github.com/ShiosOS/Damadama/rels/habits` identifies the habit collection. This URI identifies a relation; the client follows the link's advertised `href`.

Successful resources use `application/vnd.siren+json`. Collections embed members in `entities` with `rel: ["item"]`; domain values live in each resource's `properties`. Named runtime routes generate links and action targets. The browser validates unknown JSON, classes, media, status, links, and action fields at one transport boundary. Vue receives domain values and editing capabilities, not HTTP responses or Siren envelopes.

The bootstrap advertises `create-habit` and the GET forms `scheduled-habits` and `entries-by-date`. GET fields become query parameters. POST and PUT fields become JSON properties using the action's method, target and encoding. Missing or unsupported actions are protocol failures; the client has no URI-construction fallback. Each date-specific scheduled habit includes `replace-entry` even before an entry exists. Retained entries include their own action, so neither display nor editing needs a per-habit read.

An editor closes over its advertised action, date and account. Token acquisition verifies account identity both before and after awaiting the token; responses are checked again against that identity. Existing component generation and disposal guards preserve account/date privacy when responses arrive late. The fixture consumes the same bootstrap parser, using the actual host's GET `/api/config` response embedded beside tokens in `fixture.json`. This avoids adding a browser request to the fixed performance flow.

## Entry writes

PUT supplies the complete writable state, `result` and `editedAt`, together with device validation context, `deviceToday` and `timeZone`. The calendar date and habit identity belong to the resource URI. Habit name and the original Good/Better/Best definitions are read-only output. A newly inserted entry snapshots the definitions; later changes to the habit never replace that snapshot.

| Observation                             | Status and representation                                   |
| --------------------------------------- | ----------------------------------------------------------- |
| Habit created                           | 201 Siren habit with canonical `Location`                   |
| Entry first inserted                    | 201 Siren entry with canonical `Location`                   |
| Entry edit accepted or replay identical | 200 Siren entry                                             |
| Edit superseded                         | 409 problem with the authoritative Siren entry in `current` |
| Canonical entry read                    | 200 Siren entry, including Clear                            |
| Missing or foreign-owned resource       | 404 problem                                                 |

Ordering remains greatest `(editedAt UTC ticks, result rank)`, with Clear=0, Rest=1, Good=2, Better=3 and Best=4. Clear retains the resource. No If-Match precondition is required. The client adopts a 409 winner without a second fetch or retrying the rejected candidate. After a lost response, retry resends the same result and edit timestamp; an initial 201 can become 200 on replay because the resource already exists.

Creation classification uses the affected row count of `INSERT ... ON CONFLICT DO NOTHING`. A conflict then executes the original conditional `INSERT ... ON CONFLICT DO UPDATE ... WHERE` statement, retaining its conflict-row lock even when the candidate loses. The separate Read Committed winner query and commit remain in that transaction. This adds one statement for an existing entry, preserves unchanged row versions on replay/losing edits, and reports success only after commit. It does not promise that a later committed transaction cannot supersede the returned winner.

## HTTP boundary

All API responses, including the public bootstrap/profile and problems, carry `Cache-Control: private, no-store` and `Vary: Accept`. Missing Accept and acceptable wildcards select Siren. Quality values and the most specific matching media range determine acceptability; an explicit Siren `q=0` is not overridden by a broader wildcard. Unsupported response negotiation returns 406. Write bodies require `application/json`; unsupported content types return 415.

Protected route authentication runs before negotiation, body binding and semantic validation. Missing/invalid authentication returns a 401 problem and `WWW-Authenticate: Bearer`. Within a validly bound entry request, owned-habit lookup precedes field validation. Malformed JSON or incompatible JSON types are rejected by ASP.NET body binding before domain validation, as a separate transport boundary.

GET resources support HEAD with the same status/headers and no body. OPTIONS has an explicit registration and accurate Allow. Known routes reject unsupported methods with 405 and Allow; an unknown API path gets a 404 problem and cannot fall through to the SPA. API routes carry explicit contract metadata. The health endpoints are separately classified control-plane checks. The named GET `/sw.js` worker retirement route is an operational JavaScript resource, restricted to the staging authority and served with `no-store`; its existing worker retirement tests cover host restrictions and behavior. The inventory exempts only that exact route, name, method and control-plane classification. The SPA fallback is not an API resource.

## What CI proves

The runtime endpoint inventory is compared with independent semantic scenarios, including route pattern, method, name, authorization and contract classification. The scenario client begins with bootstrap and follows advertised links/actions through creation, lists, date queries, saving, replay, conflict, canonical reads and retained history. Coverage records the routes actually requested. A newly registered route cannot pass by merely annotating itself with metadata.

The same reusable response predicates reject controlled missing-affordance, wrong-status, missing-Location, conflict-as-success, cache, media and Allow violations. The browser alias test rewrites every advertised target to an opaque alias, forwards those requests to the real backend, and refuses direct resource requests. It exercises listing, creation, date selection, save, exact retry and conflict adoption. Client boundary tests exercise malformed errors, foreign targets, missing actions and account changes while token acquisition is pending.

Existing PostgreSQL tests retain literal tie cases, forced overlapping transactions, independent row/version reads and commit failures. A new HTTP test holds the first insert behind a PostgreSQL advisory lock, overlaps an identical PUT, and requires exactly one 201 and one 200 after commit. Existing UI privacy, delayed acknowledgments, retry, travel, retained snapshots, accessibility and performance tests remain in the gate. Asset budgets and the 20-request browser budget are unchanged.

These checks establish the declared application protocol and regression behavior for these scenarios. They do not prove every possible REST constraint, arbitrary intermediaries, all cache implementations, every concurrent interleaving, production Clerk sign-in, or deployed performance. Stateless account requests, client/server separation and layering still require architectural review. Code-on-demand is optional under [Fielding's REST constraints](https://ics.uci.edu/~fielding/pubs/dissertation/rest_arch_style.htm).
