Feature: Ledger postings

  Example: A Credit adds money to an account
    Given an open Checking account with balance $100.00 and $0.00 spent today
    When a Credit of $50.00 is posted
    Then the posting succeeds with a new balance of $150.00

  Example: A Debit takes money out of a Savings account and counts towards today's spending
    Given an open Savings account with balance $100.00 and $0.00 spent today
    When a Debit of $30.00 is posted
    Then the posting succeeds with a new balance of $70.00
    And the stored account has $30.00 spent today

  Example: A Fee takes money out but does not count towards today's spending
    Given an open Checking account with balance $20.00 and $0.00 spent today
    When a Fee of $2.50 is posted
    Then the posting succeeds with a new balance of $17.50
    And the stored account has $0.00 spent today

  Example: A Checking account can be overdrawn within its allowance
    Given an open Checking account with balance $10.00 and $0.00 spent today
    When a Debit of $100.00 is posted
    Then the posting succeeds with a new balance of -$90.00

  Example: An applied posting is stored once and audited
    Given an open Checking account with balance $100.00 and $0.00 spent today
    When a Debit of $10.00 is posted
    Then the account is stored once
    And an audit event records the posting as applied with a balance of $90.00

  Example: A Savings account cannot be overdrawn
    Given an open Savings account with balance $10.00 and $0.00 spent today
    When a Debit of $50.00 is posted
    Then the posting is refused with Insufficient
    And nothing is stored
    And an audit event records the posting as refused with Insufficient

  Example: A Debit that takes spending past the daily limit is refused
    Given an open Checking account with balance $5000.00 and $1500.00 spent today
    When a Debit of $800.00 is posted
    Then the posting is refused with OverLimit
    And nothing is stored
    And an audit event records the posting as refused with OverLimit

  Example: A Frozen account refuses a Debit
    Given a frozen Savings account with balance $100.00
    When a Debit of $10.00 is posted
    Then the posting is refused with AcctFrozen
    And nothing is stored

  Example: Nothing is audited if the account can't be stored
    Given an open Checking account with balance $100.00 and $0.00 spent today
    And the ledger store is unavailable
    When a Debit of $10.00 is posted
    Then the posting is refused with StoreFailed
    And no audit event is emitted

  Always: Money is whole cents. A Credit adds its amount to the balance; a Debit or a Fee subtracts it.

  Always: A Debit or Fee posting that would take the balance below the account's overdraft allowance is refused with Insufficient. The allowance is $500.00 for a Checking account and $0.00 for a Savings account. A balance exactly at the allowance is allowed. A Credit is never refused because of the balance.

  Always: A Debit posting is refused with OverLimit when the amount already spent today plus the amount of this posting is more than $2,000.00. Exactly $2,000.00 is allowed. Credit and Fee postings are not subject to the daily limit. Only an applied Debit adds to the amount spent today.

  Always: A Frozen account refuses a Debit or Fee posting with AcctFrozen. It still accepts a Credit posting.

  Always: A posting that breaks more than one rule is refused with the first of AcctFrozen, OverLimit and Insufficient that applies, in that order.

  Always: An applied posting stores the updated account once, then emits one audit event recording it as applied. A refused posting stores nothing and emits one audit event recording why it was refused. If the store fails, the result is StoreFailed and nothing is audited.
