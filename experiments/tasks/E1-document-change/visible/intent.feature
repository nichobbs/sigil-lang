Feature: Document service

  Always: A Viewer can never change anything. An Editor may update, delete or publish a document only when they own it, except that an Editor may not delete their own document while it is Published. An Admin may update, delete or publish any document. This is checked before anything else, so an actor who is not allowed gets the same answer whatever the request carries; the only thing about the document that matters is, for an Editor deleting, whether it is Published.

  Always: A document that is Deleted accepts no operation from anyone, an Admin included: the request is refused as Gone. This is checked right after the authorisation.

  Always: An update replaces the title and the size of the document with those of the request and leaves its status as it is. The new size may be at most 50000: a larger one is refused as TooLong, and exactly 50000 is allowed.

  Always: A delete sets the status to Deleted and a publish sets it to Published. Both keep the title and the size of the document, and ignore the title and the size carried by the request.

  Always: A publish of a document that is already Published is refused as AlreadyPublished, and a publish of a document whose size is 0 is refused as EmptyBody. When both apply, AlreadyPublished is reported.

  Always: When more than one refusal applies, the first of these is reported: NotAllowed, Gone, TooLong, AlreadyPublished, EmptyBody.

  Always: A request that is not refused stores the new document under its id, then emits one audit event recording the actor, the document and the operation. A refused request stores nothing and emits one audit event recording the actor, the document, the operation and the reason.

  Privacy: The title of the document is never written to the audit log.
           Changing it must not change anything audited.

  Privacy: The title carried by a request is never written to the audit log.
           Changing it must not change anything audited.

  Example: An Editor updates their own draft
    Given an Editor actor 5
    And a Draft document 101 owned by 5 titled "Q3 plan" with 800 characters
    When the actor updates the document to 1200 characters titled "Q3 plan v2"
    Then the request succeeds
    And the stored document has status Draft, 1200 characters and title "Q3 plan v2"
    And an audit event records the operation

  Example: An Admin updates a published document owned by someone else
    Given an Admin actor 1
    And a Published document 101 owned by 5 titled "Handbook" with 5000 characters
    When the actor updates the document to 5100 characters titled "Handbook"
    Then the request succeeds
    And the stored document has status Published, 5100 characters and title "Handbook"

  Example: An Editor deletes their own draft
    Given an Editor actor 5
    And a Draft document 101 owned by 5 titled "Old notes" with 300 characters
    When the actor deletes the document
    Then the request succeeds
    And the stored document has status Deleted, 300 characters and title "Old notes"
    And an audit event records the operation

  Example: An Editor cannot delete their own published document
    Given an Editor actor 5
    And a Published document 101 owned by 5 titled "Live notes" with 300 characters
    When the actor deletes the document
    Then the request is refused as NotAllowed
    And nothing is stored
    And an audit event records the refusal as NotAllowed

  Example: An Admin publishes a draft
    Given an Admin actor 1
    And a Draft document 101 owned by 5 titled "Launch post" with 450 characters
    When the actor publishes the document
    Then the request succeeds
    And the stored document has status Published, 450 characters and title "Launch post"

  Example: A Viewer cannot change anything
    Given a Viewer actor 7
    And a Draft document 101 owned by 7 titled "Mine" with 10 characters
    When the actor deletes the document
    Then the request is refused as NotAllowed
    And nothing is stored
    And an audit event records the refusal as NotAllowed

  Example: An Editor publishes their own draft
    Given an Editor actor 5
    And a Draft document 101 owned by 5 titled "Draft" with 10 characters
    When the actor publishes the document
    Then the request succeeds
    And the stored document has status Published, 10 characters and title "Draft"

  Example: An Editor cannot publish someone else's document
    Given an Editor actor 5
    And a Draft document 101 owned by 9 titled "Theirs" with 10 characters
    When the actor publishes the document
    Then the request is refused as NotAllowed
    And nothing is stored

  Example: An update that makes the document too long is refused
    Given an Editor actor 5
    And a Draft document 101 owned by 5 titled "Book" with 10 characters
    When the actor updates the document to 50001 characters titled "Book"
    Then the request is refused as TooLong
    And nothing is stored

  Example: A Deleted document accepts nothing
    Given an Editor actor 5
    And a Deleted document 101 owned by 5 titled "Gone" with 10 characters
    When the actor updates the document to 20 characters titled "Back"
    Then the request is refused as Gone
    And nothing is stored
    And an audit event records the refusal as Gone

  Example: A document that is already published cannot be published again
    Given an Admin actor 1
    And a Published document 101 owned by 5 titled "Live" with 10 characters
    When the actor publishes the document
    Then the request is refused as AlreadyPublished
    And nothing is stored

  Example: Nothing is reported as done if the document cannot be stored
    Given an Editor actor 5
    And a Draft document 101 owned by 5 titled "Notes" with 10 characters
    And the document store is unavailable
    When the actor deletes the document
    Then the request fails with "store failed"
    And nothing is audited
