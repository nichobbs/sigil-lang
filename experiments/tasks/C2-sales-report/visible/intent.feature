Feature: Sales report

  Example: Revenue is quantity times unit price, added up
    Given a sale of 2 x $10.00 of product 3 in the North
    And a sale of 1 x $5.00 of product 4 in the South
    When the report is built
    Then the total revenue is $25.00
    And the report counts 2 sales

  Example: Revenue is broken down by region
    Given a sale of 3 x $10.00 of product 1 in the North
    And a sale of 1 x $4.00 of product 2 in the East
    And a sale of 2 x $1.00 of product 1 in the North
    When the report is built
    Then the North revenue is $32.00
    And the South revenue is $0.00
    And the East revenue is $4.00
    And the West revenue is $0.00

  Example: A refunded sale does not count towards revenue
    Given a sale of 2 x $10.00 of product 3 in the North
    And a refunded sale of 5 x $10.00 of product 3 in the North
    When the report is built
    Then the total revenue is $20.00
    And the North revenue is $20.00

  Example: The best product is the one with the most revenue
    Given a sale of 1 x $10.00 of product 7 in the North
    And a sale of 1 x $6.00 of product 12 in the South
    And a sale of 1 x $6.00 of product 12 in the West
    When the report is built
    Then the best product is 12

  Example: The average is the total revenue shared over the sales counted
    Given a sale of 1 x $10.00 of product 1 in the North
    And a sale of 2 x $10.00 of product 2 in the South
    When the report is built
    Then the average sale is $15.00

  Example: A report can be limited to one region
    Given a sale of 1 x $10.00 of product 1 in the North
    And a sale of 1 x $7.00 of product 2 in the East
    And a sale of 1 x $3.00 of product 2 in the North
    And the report covers only the East
    When the report is built
    Then the total revenue is $7.00
    And the report counts 1 sales
    And the North revenue is $0.00
    And the East revenue is $7.00
    And the best product is 2

  Example: A report with no sales is empty
    Given there are no sales
    When the report is built
    Then the total revenue is $0.00
    And the report counts 0 sales
    And there is no best product
    And the average sale is $0.00

  Always: A sale is counted when it is not refunded and it is in the chosen region (every region counts when all regions are chosen). Only counted sales appear anywhere in the report: the total revenue, the regional revenues, the number of sales counted, the best product and the average sale. A region that was not chosen has revenue $0.00.

  Always: Revenue is whole cents. The revenue of a sale is its quantity times its unit price. The total revenue and the regional revenues are the sums of the revenues of the sales counted, so with all regions chosen the total equals the sum of the four regional revenues.

  Always: There is a best product exactly when at least one sale is counted. When two or more products tie on revenue, the one with the lowest product code is the best product.

  Always: The average sale is the total revenue divided by the number of sales counted, rounded half up to a whole cent: a fraction of exactly one half is rounded up. With no sales counted the average is $0.00.
