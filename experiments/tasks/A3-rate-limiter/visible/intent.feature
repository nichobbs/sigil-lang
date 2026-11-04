Feature: Rate limiter

  Rule: Each plan has a token allowance per window
    | Plan       | Tokens |
    | Free       | 100    |
    | Pro        | 1000   |
    | Enterprise | 10000  |

  Example: A request that fits in the current window is allowed
    Given a Free request costing 50 tokens
    And the window started at 0 ms with 40 tokens used
    And the request arrives at 10000 ms
    When the request is made
    Then the request is allowed with 10 tokens remaining
    And the window state is stored once, started at 0 ms with 90 tokens used
    And an audit event records the request as admitted

  Example: A request after the window has ended opens a new window
    Given a Free request costing 30 tokens
    And the window started at 0 ms with 100 tokens used
    And the request arrives at 130000 ms
    When the request is made
    Then the request is allowed with 70 tokens remaining
    And the window state is stored once, started at 130000 ms with 30 tokens used

  Example: A request that would exceed the allowance is denied
    Given a Free request costing 20 tokens
    And the window started at 0 ms with 90 tokens used
    And the request arrives at 10000 ms
    When the request is made
    Then the request is denied and may retry in 50 seconds
    And nothing is stored
    And an audit event records the request as refused

  Example: A request larger than the whole allowance is too large
    Given a Free request costing 150 tokens
    And the window started at 0 ms with 0 tokens used
    And the request arrives at 1000 ms
    When the request is made
    Then the request is too large
    And nothing is stored
    And an audit event records the request as refused

  Example: A Pro request may borrow the burst once
    Given a Pro request costing 50 tokens
    And the window started at 0 ms with 990 tokens used
    And the request arrives at 5000 ms
    When the request is made
    Then the request is allowed using the burst
    And the window state is stored once, started at 0 ms with 1040 tokens used

  Always: Time is counted in whole milliseconds. Windows are fixed and last 60 seconds. A window starts at the time of the request that opens it. A request that arrives 60 seconds or more after the start of the current window opens a new window, with nothing used and the burst unused; exactly 60 seconds after the start is already a new window. A request that arrives earlier belongs to the current window.

  Always: A request is allowed when the tokens already used in its window plus its cost do not exceed the plan's allowance; exactly the allowance is allowed. An allowed request adds its cost to the tokens used in the window. The answer reports the tokens remaining, which is the allowance minus the tokens used after the request, and is never below zero.

  Always: A request whose cost alone exceeds the plan's allowance is rejected as too large, whatever has been used in the window and whatever burst is available. A request that is too large consumes nothing, and its retry-after is 0.

  Always: A request that would exceed the allowance is denied. The retry-after tells the caller how many whole seconds to wait until the next window can start: the time left until the current window's start plus 60 seconds, rounded up to a whole second, and never less than 1.

  Always: A Pro or Enterprise request that would otherwise be denied may borrow a burst on top of the allowance. The burst is 10% of the allowance, rounded down to whole tokens, and may be borrowed once per window, only if the request then fits within the allowance plus the burst. A request that borrows the burst says so in its answer. A Free request never borrows, and a request that fits within the allowance never uses the burst.

  Privacy: The API key is never stored or written to the audit log.
           Changing it must not change anything stored or audited.
