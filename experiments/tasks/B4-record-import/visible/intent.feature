Feature: Import of untrusted records

  Always: A record is imported only if its id is at least 1, its quantity is from 1 to 1000, its unit price is from 1 cent to $100000.00 and its category is from 0 to 9. Any other record is rejected, and the first check it fails decides the reason, in this order: BadId, BadQuantity, BadPrice, UnknownCategory.

  Always: A record whose id is in the list of already imported ids is rejected as AlreadyImported, unless it fails one of the earlier checks.

  Always: An id that appears in more than one record of the same batch (counting every record of the batch, valid or not) cannot be trusted: every record that carries it is rejected as DuplicateInBatch, unless it fails one of the earlier checks, and none of them is imported.

  Always: Every record of the batch is accounted for exactly once: the number imported plus the numbers rejected for each reason equals the number of records in the batch.

  Example: A clean batch is imported and stored without the notes
    Given a record 11 of 3 at $12.50 in category 4 with the note "call me on 0412 345 678"
    And a record 12 of 10 at $0.99 in category 0 with the note "gift wrap, ship to the back door"
    When the batch is imported
    Then the report shows 2 imported
    And the stored record ids are 11 and 12
    And the stored line totals are $37.50 and $9.90
    And the audit log has one summary of 2 received, 2 imported and 0 rejected

  Example: A stored record holds only the clean fields
    Given a record 21 of 2 at $5.00 in category 9 with the note "fragile"
    When the batch is imported
    Then the stored record is 21 with quantity 2, unit price $5.00, category 9 and line total $10.00

  Example: A record with no quantity is rejected and the rest is still imported
    Given a record 31 of 0 at $4.00 in category 2 with the note "typo?"
    And a record 32 of 5 at $4.00 in category 2 with the note "ok"
    When the batch is imported
    Then the report shows 1 imported
    And the report shows 1 rejected as BadQuantity
    And the stored record id is 32
    And the audit log has one summary of 2 received, 1 imported and 1 rejected

  Example: A record with no price is rejected
    Given a record 41 of 5 at $0.00 in category 2 with the note "free"
    When the batch is imported
    Then the report shows 0 imported
    And the report shows 1 rejected as BadPrice
    And nothing is stored

  Example: An unknown category is rejected
    Given a record 51 of 5 at $3.00 in category 12 with the note "new kind of thing"
    When the batch is imported
    Then the report shows 1 rejected as UnknownCategory
    And nothing is stored

  Example: An id that was imported before is rejected
    Given the already imported ids are 61 and 62
    And a record 62 of 1 at $8.00 in category 1 with the note "again"
    And a record 63 of 1 at $8.00 in category 1 with the note "new"
    When the batch is imported
    Then the report shows 1 imported
    And the report shows 1 rejected as AlreadyImported
    And the stored record id is 63

  Example: A record that cannot be stored is rejected and the batch carries on
    Given the record store is unavailable
    And a record 71 of 1 at $8.00 in category 1 with the note "n"
    When the batch is imported
    Then the report shows 0 imported
    And the report shows 1 rejected as StoreFailed
    And nothing is stored
    And the audit log has one summary of 1 received, 0 imported and 1 rejected

  Privacy: The free-text note of a record is never stored and never written to the audit log.
