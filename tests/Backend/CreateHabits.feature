Feature: Create and read habits with an authenticated JWT
  These API examples exercise the ordinary token validator.
  They do not verify delivery of a Clerk email code.

  Scenario: Return committed habit and initial schedule
    Given an account has a valid signed token
    When the account creates Walking with its definitions and Monday and Wednesday every two weeks
    Then the server returns the saved definitions and device calendar schedule
    And both records are visible through an independent PostgreSQL connection

  Scenario: Reopen committed habit after restarting the application
    Given an account has a valid signed token
    When the account creates Walking with its definitions and Monday and Wednesday every two weeks
    Then the server returns the saved definitions and device calendar schedule
    When the application restarts against the same database
    Then the owner can list and open the saved habit with all values

  Scenario: Other account cannot read an existing owner's habit
    Given an account has a valid signed token
    When the account creates Walking with its definitions and Monday and Wednesday every two weeks
    Then the server returns the saved definitions and device calendar schedule
    And the owner can list and open the saved habit with all values
    When another account lists and opens that known habit
    Then the other account receives an empty list and not found

  Scenario: Signed-out requests receive a useful refusal
    Given an account has a valid signed token
    When the account creates Walking with its definitions and Monday and Wednesday every two weeks
    Then the server returns the saved definitions and device calendar schedule
    When a signed-out browser creates lists or opens that habit
    Then every request is refused with a sign-in error

  Scenario: A schedule is required before a habit can be saved
    Given an account has a valid signed token
    When the account attempts to create a habit without a schedule
    Then the server refuses creation and stores no habit or schedule
