Feature: Invoicing

  Rule: Discount depends on the customer's plan
    | Plan       | Discount |
    | Free       | 0%       |
    | Pro        | 10%      |
    | Enterprise | 20%      |

  Example: A Pro customer gets 10% off
    Given a Pro customer
    And an order of 2 x "W-1" at $10.00
    When the invoice is priced
    Then the total is $18.00

  Example: A Free customer pays the full price
    Given a Free customer
    And an order of 2 x "W-1" at $10.00
    When the invoice is priced
    Then the total is $20.00

  Example: Issuing an invoice stores it once and emails a receipt once
    Given an order of 1 x "W-1" at $5.00
    When an invoice is issued to "a@x.com"
    Then the invoice is stored once
    And one email is sent to "a@x.com"

  Example: Nothing is sent if the invoice can't be stored
    Given the invoice store is unavailable
    When an invoice is issued to "a@x.com"
    Then the issue fails with "store failed"
    And no email is sent

  Always: The price is never negative and never more than the undiscounted total.

  Privacy: The customer's name is only sent to mail.acme.com.
           Changing it must not change anything sent anywhere else.

  Unresolved: The invoice is stored but the email fails.
              Keep the invoice and report "mail failed", or roll back?
