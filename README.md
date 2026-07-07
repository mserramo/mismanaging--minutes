# Mismanaging Minutes

This repository contains the first oTree prototype of the Card Stacking Game.

## Local setup

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/otree devserver
```

Then open `http://localhost:8000/`.

## Development setup

The oTree demo page has one session config:

- `card_stacking`: Card Stacking Game.

After launching that session, the first page is a development-only experimenter
setup page. It lets the experimenter choose:

- the number of decision screens.

The left-to-right color order is randomized separately for each participant and
then fixed for every screen that participant sees. The main-card color is also
randomized separately for each participant and fixed for every screen that
participant sees.

This setup page is only for development. It should be removed or disabled before
the production participant flow. During development only, the final debug page
displays the active configuration so test runs are easy to audit.

The inactivity cutoff is still configured in `settings.py` with
`inactivity_seconds`.

## Data recorded per screen

Each screen is one oTree round. The app stores:

- `card_ids_json`: displayed card ids in screen order.
- `card_order_json`: displayed card ids and positions.
- `card_params_json`: full displayed card parameters, including values and colors.
- `chosen_card_id`: id of the selected card.
- `chosen_card_position`: screen position of the selected card.
- `chosen_is_main`: whether the chosen card is the no-number main card.
- `chosen_x`, `chosen_y`, `chosen_z`: selected side-card values when applicable.
- `response_time_ms`: milliseconds from screen load to choice or inactivity timeout.
- `task_elapsed_ms`: milliseconds since the first decision screen was shown.
- `timed_out_inactive`: whether the screen ended due to inactivity.

The current card values are placeholders in `card_stacking/__init__.py` under
`C.PLACEHOLDER_SIDE_CARD_VALUES`. Replace that list when the final 50 draws are
specified.
