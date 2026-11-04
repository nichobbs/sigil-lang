Feature: Catalogue search

  Always: An item that is flagged hidden never appears on a page and is never counted in the total, whatever else the query says.

  Always: An item matches a query when it is not hidden, and its category is the queried category (or the query asks for any category), and its price is at least the minimum price and at most the maximum price (both limits are inclusive), and its rating is at least the minimum rating, and, when the query asks for items in stock only, its stock is at least 1. The title is never looked at.

  Always: The matching items are ordered by the query's sort order: PriceAsc puts the cheapest first, PriceDesc puts the dearest first and RatingDesc puts the highest rating first. Items that are equal under the sort order are put in order of id, smallest first, in all three sort orders.

  Always: The total is the number of matching items over all pages. Page p (counting from 0) with page size n holds the items at positions p*n up to p*n+n-1 of the ordered matches (the first position is 0). A page past the end is empty and still reports the total. The has-more flag is true exactly when (p+1)*n is less than the total.

  Example: The cheapest items come first
    Given an item 1 in Books priced $12.00 rated 40 tenths of a star with 5 in stock
    And an item 2 in Toys priced $8.50 rated 30 tenths of a star with 2 in stock
    And an item 3 in Games priced $30.00 rated 45 tenths of a star with 0 in stock
    And the items are sorted by PriceAsc
    When page 0 is requested
    Then the page lists 2 then 1 then 3
    And there are 3 matches in all
    And there are no more pages

  Example: The dearest items come first
    Given an item 1 in Books priced $12.00 rated 40 tenths of a star with 5 in stock
    And an item 2 in Toys priced $8.50 rated 30 tenths of a star with 2 in stock
    And an item 3 in Games priced $30.00 rated 45 tenths of a star with 0 in stock
    And the items are sorted by PriceDesc
    When page 0 is requested
    Then the page lists 3 then 1 then 2

  Example: The highest rated items come first
    Given an item 1 in Books priced $12.00 rated 40 tenths of a star with 5 in stock
    And an item 2 in Toys priced $8.50 rated 30 tenths of a star with 2 in stock
    And an item 3 in Games priced $30.00 rated 45 tenths of a star with 0 in stock
    And the items are sorted by RatingDesc
    When page 0 is requested
    Then the page lists 3 then 1 then 2

  Example: Items with the same price are put in order of id
    Given an item 7 in Books priced $5.00 rated 20 tenths of a star with 1 in stock
    And an item 4 in Toys priced $5.00 rated 25 tenths of a star with 1 in stock
    And an item 9 in Games priced $3.00 rated 35 tenths of a star with 1 in stock
    And the items are sorted by PriceAsc
    When page 0 is requested
    Then the page lists 9 then 4 then 7

  Example: A category and a price range narrow the search
    Given an item 1 in Books priced $12.00 rated 40 tenths of a star with 5 in stock
    And an item 2 in Books priced $25.00 rated 40 tenths of a star with 5 in stock
    And an item 3 in Games priced $15.00 rated 40 tenths of a star with 5 in stock
    And an item 4 in Books priced $18.00 rated 40 tenths of a star with 5 in stock
    And only Books items are wanted
    And a minimum price of $10.00
    And a maximum price of $20.00
    And the items are sorted by PriceAsc
    When page 0 is requested
    Then the page lists 1 then 4
    And there are 2 matches in all

  Example: A minimum rating and in stock only narrow the search
    Given an item 1 in Books priced $12.00 rated 40 tenths of a star with 3 in stock
    And an item 2 in Books priced $9.00 rated 30 tenths of a star with 9 in stock
    And an item 3 in Books priced $7.00 rated 45 tenths of a star with 0 in stock
    And an item 4 in Books priced $20.00 rated 38 tenths of a star with 1 in stock
    And a minimum rating of 35 tenths of a star
    And only items in stock are wanted
    And the items are sorted by PriceAsc
    When page 0 is requested
    Then the page lists 1 then 4
    And there are 2 matches in all

  Example: A first page with more items behind it
    Given an item 1 in Books priced $1.00 rated 10 tenths of a star with 1 in stock
    And an item 2 in Books priced $2.00 rated 10 tenths of a star with 1 in stock
    And an item 3 in Books priced $3.00 rated 10 tenths of a star with 1 in stock
    And an item 4 in Books priced $4.00 rated 10 tenths of a star with 1 in stock
    And an item 5 in Books priced $5.00 rated 10 tenths of a star with 1 in stock
    And the page size is 2
    When page 0 is requested
    Then the page lists 1 then 2
    And there are 5 matches in all
    And there are more pages

  Example: A last page that is not full
    Given an item 1 in Books priced $1.00 rated 10 tenths of a star with 1 in stock
    And an item 2 in Books priced $2.00 rated 10 tenths of a star with 1 in stock
    And an item 3 in Books priced $3.00 rated 10 tenths of a star with 1 in stock
    And an item 4 in Books priced $4.00 rated 10 tenths of a star with 1 in stock
    And an item 5 in Books priced $5.00 rated 10 tenths of a star with 1 in stock
    And the page size is 2
    When page 2 is requested
    Then the page lists 5
    And there are 5 matches in all
    And there are no more pages

  Example: A search with no match finds nothing
    Given an item 1 in Books priced $12.00 rated 40 tenths of a star with 5 in stock
    And only Games items are wanted
    When page 0 is requested
    Then the page is empty
    And there are 0 matches in all
    And there are no more pages
