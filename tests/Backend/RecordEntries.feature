Feature: Online entries
  A signed-in owner records one result per habit and calendar date.

  Scenario: Save a past result before refusing other accounts
    Given I own a daily habit created on January 4
    When I record Good for January 4 while my device is in Tokyo on January 5
    Then Good is acknowledged with its original definitions after commit
    And another account cannot read or replace that entry
    And a signed-out browser cannot read or replace that entry
    And a fresh application reads Good for January 4

  Scenario Outline: Reject an ineligible entry date
    Given I own a daily habit created on January 4
    When I record Good for "<date>" while my device is in Tokyo on January 5
    Then the entry request is refused without storing a row

    Examples:
      | date       |
      | 2026-01-03 |
      | 2026-01-06 |

  Scenario: Refuse an unscheduled date
    Given I own a Wednesday habit created on January 4
    When I record Good for January 4 while my device is in Tokyo on January 5
    Then the entry request is refused without storing a row
