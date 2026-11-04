Feature: Tiered pricing

  Rule: The volume discount depends on the quantity on a line and applies to every unit on that line
    | Quantity | Discount |
    | 1        | 0%       |
    | 9        | 0%       |
    | 10       | 5%       |
    | 49       | 5%       |
    | 50       | 10%      |
    | 199      | 10%      |
    | 200      | 15%      |
    | 1000     | 15%      |

  Rule: The customer discount depends on the customer's tier and applies to the whole order after the volume discounts
    | Tier     | Discount |
    | Standard | 0%       |
    | Silver   | 5%       |
    | Gold     | 10%      |

  Example: A Standard customer buying a few units pays the full price
    Given a Standard customer with $0.00 credit
    And an order of 2 x "W-1" at $10.00
    When quote 1 is requested
    Then the quote total is $20.00
    And the amount due is $20.00

  Example: Buying 10 or more of a line earns the volume discount
    Given a Standard customer with $0.00 credit
    And an order of 10 x "W-1" at $10.00
    When quote 2 is requested
    Then the quote total is $95.00

  Example: A discount that is not a whole number of cents is rounded down
    Given a Standard customer with $0.00 credit
    And an order of 10 x "W-1" at $3.33
    When quote 3 is requested
    Then the quote total is $31.63

  Example: A Gold customer gets the customer discount on top
    Given a Gold customer with $0.00 credit
    And an order of 10 x "W-1" at $10.00
    When quote 4 is requested
    Then the quote total is $85.50

  Example: Account credit reduces the amount due
    Given a Silver customer with $5.00 credit
    And an order of 4 x "W-1" at $10.00
    When quote 5 is requested
    Then the quote total is $38.00
    And the credit used is $5.00
    And the amount due is $33.00

  Example: A priced quote is stored once and audited
    Given a Standard customer with $0.00 credit
    And an order of 1 x "W-1" at $5.00
    When quote 6 is requested
    Then the quote is stored once
    And an audit event records quote 6 as issued

  Example: An order above the approval limit is refused
    Given a Standard customer with $0.00 credit
    And an order of 1 x "BIG-1" at $60000.00
    When quote 7 is requested
    Then the quote is refused as needing approval
    And nothing is stored

  Example: Nothing is audited as issued if the quote can't be stored
    Given a Standard customer with $0.00 credit
    And an order of 1 x "W-1" at $5.00
    And the quote store is unavailable
    When quote 8 is requested
    Then the quote fails with "store failed"
    And no audit event records an issued quote

  Always: Money is whole cents. The volume discount is rounded down to a whole cent on each line, and the customer discount is rounded down to a whole cent once on the order.

  Always: Whatever the discounts add up to, a quote total is never more than the undiscounted total and never less than 80% of the undiscounted total, rounded up to a whole cent. The floor is checked after both discounts.

  Always: Account credit is applied last, to the total after the floor. The credit used is the smaller of the customer's credit and the quote total, so the amount due is never negative.

  Always: An order is refused with NeedsApproval exactly when its undiscounted total is above $50,000.00. Exactly $50,000.00 is allowed. A refused order stores nothing and is recorded in the audit log as refused.

  Privacy: The customer's name is never stored or written to the audit log.
           Changing it must not change anything stored or audited.

  Privacy: The customer's email is never stored or written to the audit log.
           Changing it must not change anything stored or audited.
