Feature: Notification sender with a retry policy

  Rule: The text of a notice depends on its kind
    | Kind     | Line                   |
    | Receipt  | "your receipt is ready" |
    | Reminder | "this is a reminder"    |
    | Alert    | "this is an alert"      |

  Always: A notice is posted to the channel the recipient prefers, as attempt 1. The notice is addressed to the recipient's email when the channel is Email and to the recipient's phone when it is Sms. Its text is "Hello <name>, " followed by the line for its kind.

  Always: When the post of an attempt fails, the next attempt is made if the attempt policy allows one. The policy allows at most its maxAttempts attempts, and never more than 3 attempts in total, whatever maxAttempts says. The attempt that succeeds ends the sending: the outcome is Delivered and the number of attempts is that attempt's number.

  Always: Attempt 2 is made on the other channel when the policy's fallback flag is set; otherwise every attempt is made on the preferred channel. Attempt 3 is made on the preferred channel again. When the last allowed attempt fails the outcome is Failed, with the number of attempts made.

  Always: A recipient who has opted out is never contacted. A Receipt or a Reminder for an opted-out recipient is not posted at all: the outcome is Skipped with 0 attempts. An Alert is the one exception: it is sent to an opted-out recipient as a single attempt on the preferred channel, with no retry and no fallback, whatever the attempt policy says; the outcome is Delivered or Failed with 1 attempt.

  Always: Exactly one audit event is emitted for every call, after the sending is finished (also when the notice was skipped or failed). It records the recipient's id, the kind of the notice, the outcome and the number of attempts.

  Privacy: The recipient's name, email and phone number are only ever sent to the delivery services. They are never written to the audit log.
           Changing them must not change anything audited.

  Example: A receipt is delivered on the preferred channel
    Given a recipient 7 named "Ada" who prefers Email
    And the recipient's email is "ada@example.com"
    When a Receipt notice is sent
    Then the notice is delivered on attempt 1
    And the email service is sent "Hello Ada, your receipt is ready" for "ada@example.com" on attempt 1
    And the sms service received 0 notices
    And an audit event records Delivered, attempts 1

  Example: A text message is sent to the phone number
    Given a recipient 8 named "Grace" who prefers Sms
    And the recipient's phone is "+61400111222"
    When a Reminder notice is sent
    Then the notice is delivered on attempt 1
    And the sms service is sent "Hello Grace, this is a reminder" for "+61400111222" on attempt 1
    And the email service received 0 notices

  Example: A failed post falls back to the other channel
    Given a recipient 7 named "Ada" who prefers Email
    And the recipient's email is "ada@example.com"
    And the recipient's phone is "+61400111222"
    And the policy allows 3 attempts
    And the policy allows a fallback channel
    And the email service is unavailable
    When a Receipt notice is sent
    Then the notice is delivered on attempt 2
    And the sms service is sent "Hello Ada, your receipt is ready" for "+61400111222" on attempt 2
    And the email service received 0 notices
    And an audit event records Delivered, attempts 2

  Example: A notice that cannot be delivered is reported as failed
    Given a recipient 9 named "Bob" who prefers Sms
    And the policy allows 2 attempts
    And the sms service is unavailable
    When a Reminder notice is sent
    Then the notice fails, attempts 2
    And no notice is sent
    And an audit event records Failed, attempts 2

  Example: A receipt for an opted-out recipient is skipped
    Given a recipient 7 named "Ada" who prefers Email
    And the recipient has opted out
    When a Receipt notice is sent
    Then the notice is skipped
    And no notice is sent
    And an audit event records Skipped, attempts 0

  Example: An alert still reaches an opted-out recipient
    Given a recipient 7 named "Ada" who prefers Email
    And the recipient's email is "ada@example.com"
    And the recipient has opted out
    When an Alert notice is sent
    Then the notice is delivered on attempt 1
    And the email service is sent "Hello Ada, this is an alert" for "ada@example.com" on attempt 1
    And an audit event records Delivered, attempts 1
