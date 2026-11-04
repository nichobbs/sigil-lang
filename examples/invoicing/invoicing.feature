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

  Example: If the email fails the invoice is kept and the failure is reported
    Given the mail service is unavailable
    When an invoice is issued to "a@x.com"
    Then the invoice is stored once
    And the issue fails with "mail failed"
    And an audit event records the failed receipt for the stored invoice

  Example: Issuing an invoice records an audit event
    Given an order of 1 x "W-1" at $5.00
    When an invoice is issued to "a@x.com"
    Then an audit event is recorded for the issued invoice

  Example: The receipt names the invoice, the customer and the total
    Given a customer named "Ada Lovelace"
    And invoice 1042 totalling $9.00
    When the receipt is written
    Then the email subject is "Invoice 1042"
    And the email body is "Hello Ada Lovelace, your total is $9.00"

  Always: The price is never negative and never more than the undiscounted total.

  Privacy: The customer's name is only sent to mail.acme.com.
           Changing it must not change anything sent anywhere else.
