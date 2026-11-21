# ledger: a tiny expense tracker CLI

Build `ledger.py`, run as `python3 ledger.py <command> ...`. Data lives in a JSON file whose path is the
environment variable `LEDGER_FILE` (create it if missing). Amounts are decimal numbers with at most 2 decimals;
always print them with exactly 2 decimals. Dates are `YYYY-MM-DD`; when omitted, use today's date.
Categories are case-insensitive and stored lowercased. Exit code 0 on success, 2 on any usage or input error
(with a one-line message on stderr starting with `error:`).

## Commands

`add <amount> <category> [--note TEXT] [--date YYYY-MM-DD]`
: Records an expense. Prints `added #<id> <amount> <category>` where ids start at 1 and increase.
  Amount must be > 0.

`list [--category C] [--month YYYY-MM]`
: Prints one line per matching expense, oldest date first (ties by id):
  `#<id> <date> <amount> <category>` followed by ` - <note>` when there is a note.
  Prints `no expenses` when nothing matches.

`summary [--month YYYY-MM]`
: Prints one line per category, `<category>: <total>`, largest total first (ties alphabetical),
  then a final line `total: <grand total>`. Prints `no expenses` when nothing matches.

`delete <id>`
: Removes the expense. Prints `deleted #<id>`. Unknown id is an error.

`budget set <category> <amount>`
: Sets a monthly budget. Prints `budget <category> <amount>`.

`budget check [--month YYYY-MM]`
: For each category with a budget, alphabetical, prints `<category>: <spent> / <budget> OK` or
  `<category>: <spent> / <budget> OVER by <excess>`. Month defaults to the current month.
  Prints `no budgets` when none are set.

`export <path.csv>`
: Writes all expenses as CSV with header `id,date,amount,category,note` (oldest first, ties by id),
  amounts with 2 decimals, empty note as an empty field. Prints `exported <n> expenses`.
