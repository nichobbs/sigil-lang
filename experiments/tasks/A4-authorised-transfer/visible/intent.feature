Feature: Authorised transfer

  Always: A Customer may only move money out of an account they own. A Teller or an Admin may move money out of any account. This is checked before anything else, so an actor who is not allowed gets the same answer whatever the balances are.

  Always: A transfer of more than $10,000.00 needs approval, otherwise it is refused as NeedsApproval. A transfer of exactly $10,000.00 does not need approval. Approval counts only when an Admin gives it: the approved flag is ignored when the actor is a Customer or a Teller.

  Always: The source account must hold at least the amount, otherwise the transfer is refused as Insufficient. Moving exactly the whole balance is allowed.

  Always: The source and the destination must be different accounts, otherwise the transfer is refused as SameAccount, and the amount must be at least 1 cent, otherwise it is refused as BadAmount.

  Always: When more than one refusal applies, the first of these is reported: NotAllowed, SameAccount, BadAmount, NeedsApproval, Insufficient.

  Always: A transfer that is not refused moves the amount from the source to the destination. The new source record is stored first, then the new destination record, and one audit event records the actor, the source, the destination and the amount.

  Always: Every refusal is recorded in the audit log with its reason and stores nothing. The record of a refusal names the actor, the source, the destination, the amount and the reason, and never contains a balance.

  Example: A Customer moves money out of their own account
    Given a Customer actor 5
    And a source account 101 owned by 5 holding $500.00
    And a destination account 202 owned by 9 holding $20.00
    When $120.00 is transferred
    Then the transfer succeeds
    And the stored balances are $380.00 and $140.00
    And an audit event records the transfer of $120.00

  Example: A Teller moves money out of an account that is not theirs
    Given a Teller actor 6
    And a source account 101 owned by 5 holding $500.00
    And a destination account 202 owned by 9 holding $20.00
    When $75.50 is transferred
    Then the transfer succeeds
    And the stored balances are $424.50 and $95.50

  Example: An Admin who approves a large transfer can make it
    Given an Admin actor 1
    And a source account 101 owned by 5 holding $50000.00
    And a destination account 202 owned by 9 holding $0.00
    And approval is given
    When $20000.00 is transferred
    Then the transfer succeeds
    And the stored balances are $30000.00 and $20000.00

  Example: A Customer cannot move money out of someone else's account
    Given a Customer actor 5
    And a source account 101 owned by 9 holding $500.00
    And a destination account 202 owned by 5 holding $20.00
    When $10.00 is transferred
    Then the transfer is refused as NotAllowed
    And nothing is stored

  Example: A transfer larger than the balance is refused
    Given a Customer actor 5
    And a source account 101 owned by 5 holding $50.00
    And a destination account 202 owned by 9 holding $20.00
    When $60.00 is transferred
    Then the transfer is refused as Insufficient
    And nothing is stored

  Example: A large transfer without approval is refused
    Given a Customer actor 5
    And a source account 101 owned by 5 holding $50000.00
    And a destination account 202 owned by 9 holding $20.00
    When $20000.00 is transferred
    Then the transfer is refused as NeedsApproval
    And nothing is stored

  Example: A transfer to the same account is refused
    Given a Teller actor 6
    And a source account 101 owned by 5 holding $500.00
    And a destination account 101 owned by 5 holding $500.00
    When $10.00 is transferred
    Then the transfer is refused as SameAccount
    And nothing is stored

  Example: Nothing is reported as done if the accounts cannot be stored
    Given a Customer actor 5
    And a source account 101 owned by 5 holding $500.00
    And a destination account 202 owned by 9 holding $20.00
    And the account store is unavailable
    When $10.00 is transferred
    Then the transfer fails with "store failed"
