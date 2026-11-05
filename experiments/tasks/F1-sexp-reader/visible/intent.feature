Feature: S-expression reader

  Always: The source must hold exactly one top-level item. A second top-level item is refused as Trailing, no item at all as Empty.

  Always: The tree lists the nodes in post-order, children before their parent in source order, the top-level item last, which is the only node with parent -1. Each node records its kind, its start and end offsets in characters (end is just after the last character), the index of its parent and its number of direct children.

  Example: An atom
    Given the source "hello"
    When the source is read
    Then the tree has 1 nodes
    And node 0 is an Atom from 0 to 5 with parent -1 and 0 children

  Example: A form with an atom and a nested form
    Given the source "(add 1 (mul 2 3))"
    When the source is read
    Then the tree has 7 nodes
    And node 0 is an Atom from 1 to 4 with parent 6 and 0 children
    And node 4 is an Atom from 14 to 15 with parent 5 and 0 children
    And node 5 is a Form from 7 to 16 with parent 6 and 3 children
    And node 6 is a Form from 0 to 17 with parent -1 and 3 children

  Example: Comments and texts
    Given the source "(say " then the text "a (b)" then " x) ; hi"
    When the source is read
    Then the tree has 4 nodes
    And node 1 is a Text from 5 to 12 with parent 3 and 0 children

  Example: An empty form
    Given the source "()"
    When the source is read
    Then the tree has 1 nodes
    And node 0 is a Form from 0 to 2 with parent -1 and 0 children

  Example: Nothing to read
    Given the source "  ; just a comment"
    When the source is read
    Then reading fails with Empty

  Example: A stray closing parenthesis
    Given the source "(a))"
    When the source is read
    Then reading fails with Stray

  Example: Two top-level items
    Given the source "(a) b"
    When the source is read
    Then reading fails with Trailing

  Example: An unclosed form
    Given the source "(a (b)"
    When the source is read
    Then reading fails with Unclosed

  Example: An unterminated text
    Given the source "(a " then an unclosed quote and "b)"
    When the source is read
    Then reading fails with UnterminatedText
