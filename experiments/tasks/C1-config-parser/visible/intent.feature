Feature: Configuration file parser

  Always: The text is read line by line. Lines are separated by a newline character; the first line is line 1, and blank lines and comment lines count. A line is blank when it holds only spaces and tabs, and a comment line when its first character after any spaces and tabs is a hash. Blank lines and comment lines are skipped.

  Always: A setting line is a key, an equals sign and a value, with any number of spaces and tabs around the key, around the equals sign and around the value. After the value, a hash starts a comment that runs to the end of the line.

  Always: A key starts with a letter or an underscore, continues with letters, digits, underscores, dots and hyphens, and has at most 64 characters. Letters are the plain English letters A to Z and a to z, and case matters. The key is everything before the first equals sign on the line, without the spaces and tabs around it. A line whose key is not valid, or that has no equals sign, is refused as BadKey.

  Always: A value is an integer, a boolean or a quoted string. An integer is an optional plus or minus sign and then one or more digits, with any number of leading zeros, and its value must be from -2147483648 to 2147483647 inclusive; any other whole number is refused as BadValue. A boolean is exactly true or exactly false in lower case.

  Always: A quoted string starts with a double quote and ends at the next double quote on the same line. It can hold any other characters, including hashes, equals signs, spaces and tabs, and it has no escape sequences. A hash inside a quoted string is part of the string and never starts a comment. A string that starts with a double quote and has no closing double quote on its line is refused as Unterminated.

  Always: Anything else in the value position, and anything other than spaces, tabs or a comment after the value, is refused as BadValue. A missing value, or a comment where the value should be, is refused as BadValue. A carriage return is an ordinary character, not a space.

  Always: A key may be set only once. A second setting line for a key that an earlier line already set is refused as Duplicate, and keys that differ in case are different keys. The first of the checks on a line that fails decides its reason, in this order: BadKey, then Unterminated or BadValue for the value, then Duplicate.

  Always: The result lists the settings in the order of their lines. When any line is refused, the result is only the error: the number of the first refused line and its reason. Lines after that line are not examined.

  Example: Integers, booleans and strings
    Given the config line "port = 8080"
    And the config line "debug = true"
    And the string setting "name" is "api"
    When the config is parsed
    Then the config has 3 settings
    And the setting "port" is the integer 8080
    And the setting "debug" is true
    And the setting "name" is the text "api"

  Example: Comments and blank lines are skipped
    Given the config line "# server settings"
    And the config line ""
    And the config line "retries = -3   # per request"
    And the config line "   "
    And the config line "verbose=false"
    When the config is parsed
    Then the config has 2 settings
    And the setting "retries" is the integer -3
    And the setting "verbose" is false

  Example: A string keeps its spaces
    Given the string setting "greeting" is "  hello world  "
    When the config is parsed
    Then the config has 1 settings
    And the setting "greeting" is the text "  hello world  "

  Example: An empty config has no settings
    When the config is parsed
    Then the config has 0 settings

  Example: A bad value is reported with its line number
    Given the config line "# first"
    And the config line "port = 80"
    And the config line "debug = yes"
    When the config is parsed
    Then the parse fails on line 3 with BadValue
