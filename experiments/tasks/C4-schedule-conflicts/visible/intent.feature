Feature: Room booking conflicts

  Always: A request is refused as BadRange when its end is not after its start, or when its end is after minute 10080 (the end of the week). This is checked first, whatever the existing bookings are.

  Always: Times are minutes from the start of the week and every booking covers its start minute up to, but not including, its end minute. Two bookings that only touch, where one ends at the minute the other starts, do not overlap.

  Always: The request carries a buffer, the number of minutes that must separate it from every other booking, on both sides. A booking conflicts with the request when the request, widened by the buffer on both sides, overlaps it. A booking that is exactly the buffer away does not conflict.

  Always: A Staff request is refused as Conflict when any existing booking conflicts with it, whatever that booking's status.

  Always: A Manager request may displace conflicting bookings that are Tentative. A Manager request is refused as Conflict when any conflicting booking is Confirmed, and nothing is displaced in that case.

  Always: When a request is refused as Conflict, the refusal names the lowest id among the bookings that block the request. For a Staff request every conflicting booking blocks it; for a Manager request only the conflicting Confirmed bookings block it.

  Always: An accepted request is stored as a new booking with the requested start and end. A booking requested by Staff is stored as Tentative, and one requested by a Manager is stored as Confirmed. The result lists the ids of the displaced bookings, in the order the existing bookings were given. One audit event records the requester's role, the new booking's id and the displaced ids, and nothing else. A refused or failed request stores nothing and emits nothing.

  Example: A request in a free room is accepted
    Given a booking 1 from minute 600 to minute 660 that is Confirmed
    When a Staff requests booking 2 from minute 720 to minute 780
    Then the booking is accepted
    And the booking is stored as Tentative
    And an audit event records the Staff booking 2

  Example: A Manager's request is stored as Confirmed
    Given a booking 1 from minute 600 to minute 660 that is Confirmed
    When a Manager requests booking 2 from minute 720 to minute 780
    Then the booking is accepted
    And the booking is stored as Confirmed

  Example: A request that overlaps a Confirmed booking is refused
    Given a booking 1 from minute 600 to minute 660 that is Confirmed
    When a Staff requests booking 2 from minute 630 to minute 690
    Then the request is refused as Conflict with booking 1
    And nothing is stored

  Example: A Manager displaces a Tentative booking
    Given a booking 4 from minute 600 to minute 660 that is Tentative
    When a Manager requests booking 5 from minute 630 to minute 690
    Then the booking is accepted
    And the booking is stored as Confirmed
    And an audit event records the Manager booking 5

  Example: A Manager cannot displace a Confirmed booking
    Given a booking 4 from minute 600 to minute 660 that is Tentative
    And a booking 7 from minute 640 to minute 700 that is Confirmed
    When a Manager requests booking 5 from minute 630 to minute 690
    Then the request is refused as Conflict with booking 7
    And nothing is stored

  Example: A buffer keeps bookings apart
    Given a booking 1 from minute 600 to minute 660 that is Confirmed
    And a buffer of 30 minutes
    When a Staff requests booking 2 from minute 670 to minute 730
    Then the request is refused as Conflict with booking 1

  Example: A request that ends after the week is refused
    When a Staff requests booking 2 from minute 10000 to minute 10100
    Then the request is refused as BadRange
    And nothing is stored

  Example: Nothing is reported as booked if the booking cannot be stored
    Given the booking store is unavailable
    When a Staff requests booking 2 from minute 720 to minute 780
    Then the request is refused as StoreFailed
    And nothing is stored
