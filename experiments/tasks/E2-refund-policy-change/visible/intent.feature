Feature: Audited refund

  Rule: The most one refund may return depends on the role of the actor and on the reason (a Goodwill refund has half the cap)
    | Role    | Reason    | Cap       |
    | Support | Defective | $200.00   |
    | Manager | Defective | $1000.00  |
    | Admin   | Defective | $10000.00 |
    | Support | Goodwill  | $100.00   |
    | Manager | Goodwill  | $500.00   |
    | Admin   | Goodwill  | $5000.00  |

  Always: Only a Settled payment can be refunded. A Voided payment is refused as NotRefundable. A Disputed payment can be refunded only by a Manager or an Admin: a Support actor is refused as NeedsManager, except when the reason is Fraud, which Support may refund on a Disputed payment like on a Settled one.

  Always: A refund must be at least 1 cent, otherwise it is refused as BadAmount.

  Always: A payment can be refunded in several parts, but never for more than it was paid. A refund is refused as ExceedsRemaining when it is more than what is left to refund, which is the amount of the payment minus everything already refunded. Refunding exactly what is left is allowed.

  Always: A single refund may not be more than the cap for the role of the actor and the reason of the refund (Goodwill refunds have half the cap of the other reasons). Refunding exactly the cap is allowed. The cap applies to each refund on its own, not to the running total refunded on the payment. A refund over the cap is refused as OverCap.

  Always: When more than one refusal applies, the first of these is reported: NotRefundable, NeedsManager, BadAmount, OverCap, ExceedsRemaining.

  Always: A refund that is not refused stores the updated payment, with the amount added to what has been refunded and everything else unchanged, and the audit log records one RefundIssued event with the actor, the payment, the amount and the reason.

  Always: Every refusal, and a failure to store the payment, is recorded in the audit log as a RefundRefused event with the actor, the payment, the amount, the reason and the cause, and stores nothing.

  Privacy: The card's last four digits are stored with the payment but never appear in the audit log, whether the refund is made or refused.

  Example: A Goodwill refund has half the cap
    Given a Support actor 11
    And a Settled payment 5001 of $1000.00 with $0.00 already refunded on the card ending "4242"
    When $150.00 is refunded as Goodwill
    Then the refund is refused as OverCap
    And nothing is stored

  Example: Support refunds a disputed payment as Fraud
    Given a Support actor 11
    And a Disputed payment 5001 of $150.00 with $0.00 already refunded on the card ending "4242"
    When $60.00 is refunded as Fraud
    Then the refund succeeds
    And the stored payment holds $60.00 refunded

  Example: Support refunds part of a settled payment
    Given a Support actor 11
    And a Settled payment 5001 of $150.00 with $0.00 already refunded on the card ending "4242"
    When $60.00 is refunded as Defective
    Then the refund succeeds
    And the stored payment holds $60.00 refunded
    And the stored payment keeps the card ending "4242"
    And the remaining amount to refund is $90.00
    And an audit event records the refund of $60.00 as Defective

  Example: A second refund adds to the first
    Given a Support actor 11
    And a Settled payment 5001 of $150.00 with $60.00 already refunded on the card ending "4242"
    When $90.00 is refunded as Duplicate
    Then the refund succeeds
    And the stored payment holds $150.00 refunded
    And the remaining amount to refund is $0.00

  Example: A Manager refunds more than Support could
    Given a Manager actor 12
    And a Settled payment 5002 of $800.00 with $0.00 already refunded on the card ending "0007"
    When $750.00 is refunded as Defective
    Then the refund succeeds
    And the stored payment holds $750.00 refunded

  Example: An Admin refunds more than a Manager could
    Given an Admin actor 13
    And a Settled payment 5003 of $5000.00 with $0.00 already refunded on the card ending "1111"
    When $4000.00 is refunded as Fraud
    Then the refund succeeds
    And the stored payment holds $4000.00 refunded

  Example: A Manager refunds a disputed payment
    Given a Manager actor 12
    And a Disputed payment 5004 of $300.00 with $0.00 already refunded on the card ending "9999"
    When $300.00 is refunded as Fraud
    Then the refund succeeds
    And an audit event records the refund of $300.00 as Fraud

  Example: Support cannot refund a disputed payment
    Given a Support actor 11
    And a Disputed payment 5004 of $300.00 with $0.00 already refunded on the card ending "9999"
    When $10.00 is refunded as Goodwill
    Then the refund is refused as NeedsManager
    And nothing is stored
    And an audit event records the refusal of $10.00 as Goodwill because NeedsManager

  Example: A voided payment cannot be refunded
    Given an Admin actor 13
    And a Voided payment 5005 of $100.00 with $0.00 already refunded on the card ending "2222"
    When $10.00 is refunded as Duplicate
    Then the refund is refused as NotRefundable
    And nothing is stored

  Example: A refund of more than the payment is refused
    Given a Manager actor 12
    And a Settled payment 5006 of $100.00 with $0.00 already refunded on the card ending "3333"
    When $120.00 is refunded as Goodwill
    Then the refund is refused as ExceedsRemaining
    And nothing is stored

  Example: A refund of nothing is refused
    Given a Support actor 11
    And a Settled payment 5006 of $100.00 with $0.00 already refunded on the card ending "3333"
    When $0.00 is refunded as Goodwill
    Then the refund is refused as BadAmount
    And nothing is stored

  Example: Nothing is reported as done if the payment cannot be stored
    Given a Support actor 11
    And a Settled payment 5001 of $150.00 with $0.00 already refunded on the card ending "4242"
    And the payment store is unavailable
    When $10.00 is refunded as Defective
    Then the refund fails because the payment could not be stored
    And nothing is stored
    And an audit event records the refusal of $10.00 as Defective because StoreFailed
