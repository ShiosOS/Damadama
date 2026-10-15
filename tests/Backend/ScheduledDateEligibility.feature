Feature: Scheduled date eligibility
  Calendar dates use the stored creation date, selected ISO weekdays, and Monday repeat anchor.
  A missed date is never moved onto another day.

  Scenario Outline: Eligibility repeats from the stored Monday and never predates creation
    Given a habit created on "2026-10-14" with ISO weekdays "1,3,7" every 2 weeks
    When eligibility is requested for "<date>"
    Then the scheduled result is <scheduled>

    Examples:
      | date       | scheduled |
      | 2026-10-12 | false     |
      | 2026-10-14 | true      |
      | 2026-10-15 | false     |
      | 2026-10-18 | true      |
      | 2026-10-19 | false     |
      | 2026-10-25 | false     |
      | 2026-10-26 | true      |

  Scenario: A missed Wednesday does not become Thursday work
    Given a habit created on "2026-10-14" with ISO weekdays "3" every 1 weeks
    When eligibility is requested for "2026-10-14"
    Then the scheduled result is true
    When eligibility is requested for "2026-10-15"
    Then the scheduled result is false
    When eligibility is requested for "2026-10-21"
    Then the scheduled result is true
