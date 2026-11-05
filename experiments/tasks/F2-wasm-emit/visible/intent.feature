Feature: Expression to WebAssembly

  Always: The module is the fixed header, a type section, a function section, an export section naming the function "f", and a code section whose body holds the instructions of the nodes in order, each section carrying its length as an unsigned LEB128 and each constant written as a signed LEB128 of minimal length.

  Example: A constant
    Given the node Const 5
    When the module is emitted
    Then the module has 36 bytes
    And byte 0 is 0
    And byte 1 is 97
    And byte 33 is 66
    And byte 34 is 5
    And byte 35 is 11

  Example: Two parameters added
    Given the node Param0 0
    And the node Param1 0
    And the node Add 0
    When the module is emitted
    Then the module has 39 bytes
    And byte 33 is 32
    And byte 37 is 124

  Example: A negative constant needs a signed encoding
    Given the node Const -1
    When the module is emitted
    Then the module has 36 bytes
    And byte 34 is 127

  Example: A constant that needs two bytes
    Given the node Const 64
    When the module is emitted
    Then the module has 37 bytes
    And byte 34 is 192
    And byte 35 is 0

  Example: An operator with too few operands
    Given the node Const 1
    And the node Add 0
    When the module is emitted
    Then emitting fails with StackUnderflow

  Example: Two values left on the stack
    Given the node Const 1
    And the node Const 2
    When the module is emitted
    Then emitting fails with BadShape
