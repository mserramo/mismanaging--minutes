from otree.api import *

import json
from pathlib import Path
import random


doc = """
Card Stacking Game prototype for Mismanaging Minutes.
Participants see card-choice screens until a configurable time limit expires.
Each screen records the displayed card parameters, display order, selected card
id, and response time.
"""


class C(BaseConstants):
    NAME_IN_URL = 'card_stacking'
    PLAYERS_PER_GROUP = None

    MAX_DURATION_MINUTES = 40
    FASTEST_DECISION_SECONDS = 0.5
    NUM_ROUNDS = int(MAX_DURATION_MINUTES * 60 / FASTEST_DECISION_SECONDS)

    DEFAULT_DURATION_MINUTES = 1
    DEFAULT_NUM_SCREEN_TYPES = 50
    DEFAULT_SCREEN_TYPES_FILE = 'screen_types.txt'
    DEFAULT_CLICK_FEEDBACK_MS = 1100
    MAX_CLICK_FEEDBACK_MS = 5000
    MAIN_BONUS_THRESHOLD_PER_MINUTE = 50
    MAIN_BONUS_POINTS_PER_MAIN_CARD = 15

    MAIN_CARD_ID = 'main'

    CARD_DECK = [
        dict(color_id='blue', label='Blue card', color='#2563eb'),
        dict(color_id='green', label='Green card', color='#16a34a'),
        dict(color_id='amber', label='Amber card', color='#f59e0b'),
        dict(color_id='rose', label='Rose card', color='#e11d48'),
        dict(color_id='violet', label='Violet card', color='#7c3aed'),
    ]


class Subsession(BaseSubsession):
    pass


class Group(BaseGroup):
    pass


class Player(BasePlayer):
    setup_duration_minutes = models.FloatField(
        label='Task duration in minutes',
        initial=C.DEFAULT_DURATION_MINUTES,
    )
    setup_show_elapsed_minutes = models.BooleanField(
        label='Show time-left counter to participant?',
        initial=True,
    )
    setup_show_main_cards_collected = models.BooleanField(
        label='Show main-card counter to participant?',
        initial=True,
    )
    setup_click_feedback_ms = models.IntegerField(
        label='Common post-click feedback delay in milliseconds',
        initial=C.DEFAULT_CLICK_FEEDBACK_MS,
    )
    setup_bonus_threshold_main_cards = models.IntegerField(
        label='Main-card bonus threshold (L)',
        initial=int(C.DEFAULT_DURATION_MINUTES * C.MAIN_BONUS_THRESHOLD_PER_MINUTE),
    )
    setup_main_bonus_points = models.FloatField(
        label='Main-card bonus points (Q)',
        initial=(
            C.DEFAULT_DURATION_MINUTES
            * C.MAIN_BONUS_THRESHOLD_PER_MINUTE
            * C.MAIN_BONUS_POINTS_PER_MAIN_CARD
        ),
    )
    task_duration_minutes = models.FloatField()
    num_screen_types = models.IntegerField()
    show_elapsed_minutes = models.BooleanField()
    show_main_cards_collected = models.BooleanField()
    click_feedback_ms = models.IntegerField()
    bonus_threshold_main_cards = models.IntegerField()
    main_bonus_points = models.FloatField()
    inactivity_seconds = models.IntegerField()
    screen_type_index = models.IntegerField(blank=True)

    visible_card_count = models.IntegerField()
    card_ids_json = models.LongStringField()
    card_order_json = models.LongStringField()
    card_params_json = models.LongStringField()

    chosen_card_id = models.StringField(blank=True)
    chosen_card_position = models.IntegerField(blank=True)
    chosen_is_main = models.BooleanField(blank=True)
    chosen_x = models.FloatField(blank=True)
    chosen_y = models.FloatField(blank=True)
    chosen_z = models.FloatField(blank=True)

    response_time_ms = models.IntegerField(blank=True)
    task_elapsed_ms = models.IntegerField(blank=True)
    main_cards_collected = models.IntegerField(initial=0)
    points_before = models.FloatField(blank=True)
    card_points_added = models.FloatField(blank=True)
    multiplier_applied = models.BooleanField(blank=True)
    multiplier_y = models.FloatField(blank=True)
    multiplier_z = models.FloatField(blank=True)
    main_bonus_triggered_this_round = models.BooleanField(initial=False)
    main_bonus_points_added = models.FloatField(blank=True)
    points_after = models.FloatField(blank=True)
    timed_out_inactive = models.BooleanField(initial=False)
    timed_out_task_duration = models.BooleanField(initial=False)


def _session_config(player, key, default):
    return player.session.config.get(key, default)


def configured_num_screen_types(session):
    return int(session.config.get('num_screen_types', C.DEFAULT_NUM_SCREEN_TYPES))


def configured_screen_types_file(session):
    return session.config.get('screen_types_file', C.DEFAULT_SCREEN_TYPES_FILE)


def _extra_field(obj, field_name, default=None):
    try:
        return getattr(obj, field_name)
    except KeyError:
        return default


def participant_color_order(participant):
    color_order_json = _extra_field(participant, 'card_stacking_color_order_json')
    if color_order_json:
        return json.loads(color_order_json)
    return list(range(len(C.CARD_DECK)))


def participant_main_color_index(participant):
    value = _extra_field(participant, 'card_stacking_main_color_index')
    if value is None:
        return participant_color_order(participant)[0]
    return int(value)


def initialize_participant_card_randomization(participant):
    if _extra_field(participant, 'card_stacking_color_order_json'):
        return
    rng = random.Random(f'card-stacking-participant-{participant.code}')
    color_order = list(range(len(C.CARD_DECK)))
    rng.shuffle(color_order)
    participant.card_stacking_color_order_json = json.dumps(color_order)
    participant.card_stacking_main_color_index = rng.choice(color_order)


def color_order_labels(participant):
    return [
        C.CARD_DECK[color_index]['label']
        for color_index in participant_color_order(participant)
    ]


def main_card_color_label(participant):
    return C.CARD_DECK[participant_main_color_index(participant)]['label']


def format_card_value(value):
    if value is None:
        return ''
    if int(value) == value:
        return str(int(value))
    return f'{value:.1f}'


def format_clock_seconds(total_seconds):
    total_seconds = max(0, int(total_seconds))
    minutes = total_seconds // 60
    seconds = total_seconds % 60
    return f'{minutes:02d}:{seconds:02d}'


def default_bonus_threshold_main_cards(duration_minutes):
    return max(1, int(round(duration_minutes * C.MAIN_BONUS_THRESHOLD_PER_MINUTE)))


def default_main_bonus_points(bonus_threshold_main_cards):
    return float(bonus_threshold_main_cards * C.MAIN_BONUS_POINTS_PER_MAIN_CARD)


def add_display_values(card):
    for field_name in ['x', 'y', 'z']:
        card[f'display_{field_name}'] = format_card_value(card.get(field_name))
    return card


def parse_screen_type_line(line, line_number):
    parts = [part.strip() for part in line.split('|')]
    if len(parts) != 5:
        raise ValueError(
            f'Screen-types file line {line_number} must have one id and four cards.'
        )
    try:
        type_index = int(parts[0])
    except ValueError as exc:
        raise ValueError(
            f'Screen-types file line {line_number} has a non-integer type id.'
        ) from exc

    side_values = []
    for card_position, card_part in enumerate(parts[1:], start=1):
        values = [value.strip() for value in card_part.split(',')]
        if len(values) != 3:
            raise ValueError(
                f'Screen-types file line {line_number}, card {card_position} '
                'must have x,y,z.'
            )
        try:
            x, y, z = [float(value) for value in values]
        except ValueError as exc:
            raise ValueError(
                f'Screen-types file line {line_number}, card {card_position} '
                'has a non-numeric x, y, or z.'
            ) from exc
        side_values.append(dict(x=x, y=y, z=z))

    return dict(type_index=type_index, side_values=side_values)


def load_screen_types_from_file(file_name, expected_num_screen_types):
    file_path = Path(__file__).with_name(file_name)
    if not file_path.exists():
        raise FileNotFoundError(f'Screen-types file not found: {file_path}')

    screen_types = []
    for line_number, raw_line in enumerate(file_path.read_text().splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        screen_types.append(parse_screen_type_line(line, line_number))

    if len(screen_types) != expected_num_screen_types:
        raise ValueError(
            f'Expected {expected_num_screen_types} screen types in {file_path}, '
            f'found {len(screen_types)}.'
        )

    expected_ids = list(range(1, expected_num_screen_types + 1))
    actual_ids = [screen_type['type_index'] for screen_type in screen_types]
    if actual_ids != expected_ids:
        raise ValueError(
            f'Screen-types file ids must be consecutive from 1 to '
            f'{expected_num_screen_types}. Found: {actual_ids}.'
        )

    return screen_types


def generate_screen_sequence(participant, num_screen_types):
    rng = random.Random(
        f'card-stacking-screen-sequence-{participant.code}-{num_screen_types}'
    )
    return [rng.randint(1, num_screen_types) for _ in range(C.NUM_ROUNDS)]


def initialize_participant_timed_task(
    participant, num_screen_types=None, screen_types=None
):
    if num_screen_types is None:
        num_screen_types = _extra_field(
            participant, 'card_stacking_num_screen_types', C.DEFAULT_NUM_SCREEN_TYPES
        )
    num_screen_types = int(num_screen_types)
    if screen_types is None:
        screen_types = load_screen_types_from_file(
            C.DEFAULT_SCREEN_TYPES_FILE, num_screen_types
        )
    participant.card_stacking_num_screen_types = num_screen_types
    participant.card_stacking_screen_types_json = json.dumps(screen_types)
    participant.card_stacking_screen_sequence_json = json.dumps(
        generate_screen_sequence(participant, num_screen_types)
    )


def participant_screen_types(participant):
    screen_types_json = _extra_field(participant, 'card_stacking_screen_types_json')
    if not screen_types_json:
        initialize_participant_timed_task(participant)
        screen_types_json = participant.card_stacking_screen_types_json
    return json.loads(screen_types_json)


def participant_screen_sequence(participant):
    sequence_json = _extra_field(participant, 'card_stacking_screen_sequence_json')
    if not sequence_json:
        initialize_participant_timed_task(participant)
        sequence_json = participant.card_stacking_screen_sequence_json
    return json.loads(sequence_json)


def participant_task_duration_minutes(participant):
    return float(
        _extra_field(
            participant,
            'card_stacking_task_duration_minutes',
            C.DEFAULT_DURATION_MINUTES,
        )
    )


def participant_num_screen_types(participant):
    return int(
        _extra_field(
            participant, 'card_stacking_num_screen_types', C.DEFAULT_NUM_SCREEN_TYPES
        )
    )


def participant_show_elapsed_minutes(participant):
    return bool(_extra_field(participant, 'card_stacking_show_elapsed_minutes', True))


def participant_show_main_cards_collected(participant):
    return bool(
        _extra_field(participant, 'card_stacking_show_main_cards_collected', True)
    )


def participant_click_feedback_ms(participant):
    return int(
        _extra_field(
            participant,
            'card_stacking_click_feedback_ms',
            C.DEFAULT_CLICK_FEEDBACK_MS,
        )
    )


def participant_bonus_threshold_main_cards(participant):
    return int(
        _extra_field(
            participant,
            'card_stacking_bonus_threshold_main_cards',
            default_bonus_threshold_main_cards(C.DEFAULT_DURATION_MINUTES),
        )
    )


def participant_main_bonus_points(participant):
    return float(
        _extra_field(
            participant,
            'card_stacking_main_bonus_points',
            default_main_bonus_points(participant_bonus_threshold_main_cards(participant)),
        )
    )


def participant_points_accumulated(participant):
    return float(_extra_field(participant, 'card_stacking_points_accumulated', 0))


def participant_main_bonus_triggered(participant):
    return bool(_extra_field(participant, 'card_stacking_main_bonus_triggered', False))


def is_inactive(player):
    return bool(_extra_field(player.participant, 'card_stacking_inactive', False))


def is_time_finished(player):
    return bool(_extra_field(player.participant, 'card_stacking_time_finished', False))


def previous_main_cards_collected(player):
    count = 0
    for previous_player in player.in_previous_rounds():
        if previous_player.field_maybe_none('chosen_is_main'):
            count += 1
    return count


def card_from_round(player, card_id):
    if not card_id:
        return None
    cards = json.loads(player.card_params_json)
    return next((card for card in cards if card['id'] == card_id), None)


def screen_type_for_round(player):
    sequence = participant_screen_sequence(player.participant)
    screen_type_index = sequence[player.round_number - 1]
    screen_types = participant_screen_types(player.participant)
    return screen_types[screen_type_index - 1]


def build_cards_for_player(player):
    cards = []
    screen_type = screen_type_for_round(player)
    side_values = screen_type['side_values']
    main_color_index = participant_main_color_index(player.participant)
    side_index = 0

    for color_index in participant_color_order(player.participant):
        color_card = C.CARD_DECK[color_index]
        card = dict(color_card)
        card.update(
            round_number=player.round_number,
            screen_type_index=screen_type['type_index'],
        )
        if color_index == main_color_index:
            card.update(
                id=C.MAIN_CARD_ID,
                is_main=True,
                x=None,
                y=None,
                z=None,
            )
        else:
            side_index += 1
            card.update(
                id=f'side_{side_index}',
                is_main=False,
            )
            card.update(side_values[side_index - 1])
        cards.append(add_display_values(card))

    for position, card in enumerate(cards, start=1):
        card['position'] = position

    return cards


def set_round_fields(player):
    cards = build_cards_for_player(player)
    screen_type = screen_type_for_round(player)
    player.task_duration_minutes = participant_task_duration_minutes(player.participant)
    player.num_screen_types = participant_num_screen_types(player.participant)
    player.show_elapsed_minutes = participant_show_elapsed_minutes(player.participant)
    player.show_main_cards_collected = participant_show_main_cards_collected(
        player.participant
    )
    player.click_feedback_ms = participant_click_feedback_ms(player.participant)
    player.bonus_threshold_main_cards = participant_bonus_threshold_main_cards(
        player.participant
    )
    player.main_bonus_points = participant_main_bonus_points(player.participant)
    player.inactivity_seconds = int(_session_config(player, 'inactivity_seconds', 30))
    player.screen_type_index = screen_type['type_index']

    player.visible_card_count = len(cards)
    player.card_ids_json = json.dumps([card['id'] for card in cards])
    player.card_order_json = json.dumps(
        [dict(id=card['id'], position=card['position']) for card in cards]
    )
    player.card_params_json = json.dumps(cards)


def creating_session(subsession):
    num_screen_types = configured_num_screen_types(subsession.session)
    screen_types = load_screen_types_from_file(
        configured_screen_types_file(subsession.session), num_screen_types
    )
    for player in subsession.get_players():
        if player.round_number == 1:
            initialize_participant_card_randomization(player.participant)
            player.participant.card_stacking_task_duration_minutes = (
                C.DEFAULT_DURATION_MINUTES
            )
            player.participant.card_stacking_num_screen_types = num_screen_types
            player.participant.card_stacking_show_elapsed_minutes = True
            player.participant.card_stacking_show_main_cards_collected = True
            player.participant.card_stacking_click_feedback_ms = (
                C.DEFAULT_CLICK_FEEDBACK_MS
            )
            player.participant.card_stacking_bonus_threshold_main_cards = (
                default_bonus_threshold_main_cards(C.DEFAULT_DURATION_MINUTES)
            )
            player.participant.card_stacking_main_bonus_points = (
                default_main_bonus_points(
                    player.participant.card_stacking_bonus_threshold_main_cards
                )
            )
            player.participant.card_stacking_points_accumulated = 0
            player.participant.card_stacking_main_bonus_triggered = False
            player.participant.card_stacking_main_bonus_trigger_round = None
            player.participant.card_stacking_inactive = False
            player.participant.card_stacking_inactive_round = None
            player.participant.card_stacking_time_finished = False
            player.participant.card_stacking_time_finished_round = None
            initialize_participant_timed_task(
                player.participant, num_screen_types, screen_types
            )
        set_round_fields(player)


class DevelopmentSetup(Page):
    form_model = 'player'
    form_fields = [
        'setup_duration_minutes',
        'setup_show_elapsed_minutes',
        'setup_show_main_cards_collected',
        'setup_click_feedback_ms',
        'setup_bonus_threshold_main_cards',
        'setup_main_bonus_points',
    ]

    @staticmethod
    def is_displayed(player):
        return player.round_number == 1

    @staticmethod
    def error_message(player, values):
        duration_minutes = values.get('setup_duration_minutes')
        click_feedback_ms = values.get('setup_click_feedback_ms')
        bonus_threshold_main_cards = values.get('setup_bonus_threshold_main_cards')
        main_bonus_points = values.get('setup_main_bonus_points')
        if duration_minutes is None:
            return 'Enter the task duration in minutes.'
        if duration_minutes <= 0:
            return 'Task duration must be greater than 0 minutes.'
        if duration_minutes > C.MAX_DURATION_MINUTES:
            return f'Task duration cannot exceed {C.MAX_DURATION_MINUTES} minutes.'
        if click_feedback_ms is None:
            return 'Enter the common post-click feedback delay in milliseconds.'
        if click_feedback_ms < 0:
            return 'Common post-click feedback delay cannot be negative.'
        if click_feedback_ms > C.MAX_CLICK_FEEDBACK_MS:
            return (
                f'Common post-click feedback delay cannot exceed '
                f'{C.MAX_CLICK_FEEDBACK_MS} milliseconds.'
            )
        if bonus_threshold_main_cards is None:
            return 'Enter the main-card bonus threshold.'
        if bonus_threshold_main_cards < 1:
            return 'Main-card bonus threshold must be at least 1.'
        if main_bonus_points is None:
            return 'Enter the main-card bonus points.'
        if main_bonus_points < 0:
            return 'Main-card bonus points cannot be negative.'

    @staticmethod
    def before_next_page(player, timeout_happened):
        player.participant.card_stacking_task_duration_minutes = (
            player.setup_duration_minutes
        )
        player.participant.card_stacking_show_elapsed_minutes = (
            player.setup_show_elapsed_minutes
        )
        player.participant.card_stacking_show_main_cards_collected = (
            player.setup_show_main_cards_collected
        )
        player.participant.card_stacking_click_feedback_ms = (
            player.setup_click_feedback_ms
        )
        player.participant.card_stacking_bonus_threshold_main_cards = (
            player.setup_bonus_threshold_main_cards
        )
        player.participant.card_stacking_main_bonus_points = (
            player.setup_main_bonus_points
        )
        player.participant.card_stacking_points_accumulated = 0
        player.participant.card_stacking_main_bonus_triggered = False
        player.participant.card_stacking_main_bonus_trigger_round = None
        player.participant.card_stacking_time_finished = False
        player.participant.card_stacking_time_finished_round = None
        set_round_fields(player)


class Intro(Page):
    @staticmethod
    def is_displayed(player):
        return player.round_number == 1 and not is_inactive(player)


class Decision(Page):
    form_model = 'player'
    form_fields = [
        'chosen_card_id',
        'chosen_card_position',
        'chosen_is_main',
        'chosen_x',
        'chosen_y',
        'chosen_z',
        'response_time_ms',
        'task_elapsed_ms',
        'points_before',
        'card_points_added',
        'multiplier_applied',
        'multiplier_y',
        'multiplier_z',
        'main_bonus_triggered_this_round',
        'main_bonus_points_added',
        'points_after',
        'timed_out_inactive',
        'timed_out_task_duration',
    ]

    @staticmethod
    def is_displayed(player):
        set_round_fields(player)
        return (
            player.round_number <= C.NUM_ROUNDS
            and not is_inactive(player)
            and not is_time_finished(player)
        )

    @staticmethod
    def vars_for_template(player):
        cards = json.loads(player.card_params_json)
        cards = [add_display_values(card) for card in cards]
        task_duration_seconds = player.task_duration_minutes * 60
        return dict(
            cards=cards,
            inactivity_seconds=player.inactivity_seconds,
            round_number=player.round_number,
            task_timer_key=f'card_stacking_task_started_at_{player.participant.code}',
            task_duration_seconds=task_duration_seconds,
            click_feedback_ms=player.click_feedback_ms,
            bonus_threshold_main_cards=player.bonus_threshold_main_cards,
            main_bonus_points=player.main_bonus_points,
            initial_time_left_text=format_clock_seconds(task_duration_seconds),
            show_elapsed_minutes=player.show_elapsed_minutes,
            show_main_cards_collected=player.show_main_cards_collected,
            main_cards_collected_so_far=previous_main_cards_collected(player),
            points_accumulated=participant_points_accumulated(player.participant),
            points_accumulated_display=format_card_value(
                participant_points_accumulated(player.participant)
            ),
            main_bonus_already_triggered=participant_main_bonus_triggered(
                player.participant
            ),
        )

    @staticmethod
    def error_message(player, values):
        timed_out = values.get('timed_out_inactive') or values.get(
            'timed_out_task_duration'
        )
        chosen_card_id = values.get('chosen_card_id')
        if not timed_out and not chosen_card_id:
            return 'Please choose a card.'

    @staticmethod
    def before_next_page(player, timeout_happened):
        previous_main_count = previous_main_cards_collected(player)
        player.main_cards_collected = previous_main_count

        if player.timed_out_inactive:
            current_points = participant_points_accumulated(player.participant)
            player.points_before = current_points
            player.points_after = current_points
            player.participant.card_stacking_inactive = True
            player.participant.card_stacking_inactive_round = player.round_number
            return

        if player.timed_out_task_duration:
            current_points = participant_points_accumulated(player.participant)
            player.points_before = current_points
            player.points_after = current_points
            player.participant.card_stacking_time_finished = True
            player.participant.card_stacking_time_finished_round = player.round_number
            return

        chosen_card = card_from_round(player, player.chosen_card_id)
        if chosen_card:
            current_points = participant_points_accumulated(player.participant)
            if player.field_maybe_none('points_before') is None:
                player.points_before = current_points
            player.chosen_card_position = chosen_card['position']
            player.chosen_is_main = chosen_card['is_main']
            player.chosen_x = chosen_card.get('x')
            player.chosen_y = chosen_card.get('y')
            player.chosen_z = chosen_card.get('z')
            player.main_cards_collected = previous_main_count + int(
                bool(chosen_card['is_main'])
            )
            if chosen_card['is_main']:
                player.card_points_added = 0
                player.multiplier_applied = False
                player.multiplier_y = None
                player.multiplier_z = None
                if (
                    not participant_main_bonus_triggered(player.participant)
                    and player.main_cards_collected >= player.bonus_threshold_main_cards
                ):
                    player.main_bonus_triggered_this_round = True
                    player.main_bonus_points_added = player.main_bonus_points
                    player.participant.card_stacking_main_bonus_triggered = True
                    player.participant.card_stacking_main_bonus_trigger_round = (
                        player.round_number
                    )
                else:
                    player.main_bonus_triggered_this_round = False
                    player.main_bonus_points_added = 0
            else:
                if player.field_maybe_none('multiplier_applied') is None:
                    player.multiplier_applied = False
                player.card_points_added = (
                    chosen_card['x'] * chosen_card['z']
                    if player.multiplier_applied
                    else chosen_card['x']
                )
                player.multiplier_y = chosen_card.get('y')
                player.multiplier_z = chosen_card.get('z')
                player.main_bonus_triggered_this_round = False
                player.main_bonus_points_added = 0
            player.points_after = (
                player.points_before
                + (player.field_maybe_none('card_points_added') or 0)
                + (player.field_maybe_none('main_bonus_points_added') or 0)
            )
            player.participant.card_stacking_points_accumulated = player.points_after

        if player.round_number == C.NUM_ROUNDS:
            player.participant.card_stacking_time_finished = True
            player.participant.card_stacking_time_finished_round = player.round_number


class InactivityLoss(Page):
    @staticmethod
    def is_displayed(player):
        set_round_fields(player)
        return (
            is_inactive(player)
            and player.participant.card_stacking_inactive_round == player.round_number
        )

    @staticmethod
    def vars_for_template(player):
        return dict(inactivity_seconds=player.inactivity_seconds)


class Results(Page):
    @staticmethod
    def is_displayed(player):
        set_round_fields(player)
        return (
            is_time_finished(player)
            and player.participant.card_stacking_time_finished_round
            == player.round_number
            and not is_inactive(player)
        )

    @staticmethod
    def vars_for_template(player):
        decisions = []
        answered_rounds = 0
        total_task_elapsed_ms = None
        main_cards_collected = 0
        for round_player in player.in_all_rounds()[: player.round_number]:
            chosen_card_id = round_player.field_maybe_none('chosen_card_id')
            if not chosen_card_id:
                continue
            answered_rounds += 1
            response_time_ms = round_player.field_maybe_none('response_time_ms')
            total_task_elapsed_ms = round_player.field_maybe_none('task_elapsed_ms')
            main_cards_collected = round_player.field_maybe_none(
                'main_cards_collected'
            ) or main_cards_collected
            chosen_card = card_from_round(round_player, chosen_card_id)
            chosen_is_main = (
                ''
                if chosen_card is None
                else 'Yes'
                if chosen_card['is_main']
                else 'No'
            )
            decisions.append(
                dict(
                    round_number=round_player.round_number,
                    screen_type_index=round_player.field_maybe_none(
                        'screen_type_index'
                    ),
                    chosen_card_id=chosen_card_id or '',
                    chosen_card_label='' if chosen_card is None else chosen_card['label'],
                    chosen_card_position=(
                        '' if chosen_card is None else chosen_card['position']
                    ),
                    chosen_is_main=chosen_is_main,
                    chosen_x=(
                        'N/A'
                        if chosen_card and chosen_card['is_main']
                        else format_card_value(round_player.field_maybe_none('chosen_x'))
                    ),
                    chosen_y=(
                        'N/A'
                        if chosen_card and chosen_card['is_main']
                        else format_card_value(round_player.field_maybe_none('chosen_y'))
                    ),
                    chosen_z=(
                        'N/A'
                        if chosen_card and chosen_card['is_main']
                        else format_card_value(round_player.field_maybe_none('chosen_z'))
                    ),
                    points_before=format_card_value(
                        round_player.field_maybe_none('points_before')
                    ),
                    card_points_added=format_card_value(
                        round_player.field_maybe_none('card_points_added')
                    ),
                    multiplier_applied=(
                        ''
                        if chosen_card and chosen_card['is_main']
                        else 'Yes'
                        if round_player.field_maybe_none('multiplier_applied')
                        else 'No'
                    ),
                    main_bonus_triggered=(
                        'Yes'
                        if round_player.field_maybe_none(
                            'main_bonus_triggered_this_round'
                        )
                        else 'No'
                    ),
                    main_bonus_points_added=format_card_value(
                        round_player.field_maybe_none('main_bonus_points_added')
                    ),
                    points_after=format_card_value(
                        round_player.field_maybe_none('points_after')
                    ),
                    response_time_seconds=(
                        ''
                        if response_time_ms is None
                        else f'{response_time_ms / 1000:.1f}'
                    ),
                )
            )
        final_elapsed_ms = player.field_maybe_none('task_elapsed_ms')
        if final_elapsed_ms is not None:
            total_task_elapsed_ms = final_elapsed_ms
        total_task_elapsed_seconds = (
            ''
            if total_task_elapsed_ms is None
            else f'{total_task_elapsed_ms / 1000:.1f}'
        )
        return dict(
            decisions=decisions,
            task_duration_minutes=player.task_duration_minutes,
            num_screen_types=player.num_screen_types,
            show_elapsed_minutes=player.show_elapsed_minutes,
            show_main_cards_collected=player.show_main_cards_collected,
            click_feedback_ms=player.click_feedback_ms,
            bonus_threshold_main_cards=player.bonus_threshold_main_cards,
            main_bonus_points=format_card_value(player.main_bonus_points),
            answered_rounds=answered_rounds,
            main_cards_collected=main_cards_collected,
            points_accumulated=format_card_value(
                participant_points_accumulated(player.participant)
            ),
            main_bonus_triggered=participant_main_bonus_triggered(player.participant),
            main_bonus_trigger_round=_extra_field(
                player.participant, 'card_stacking_main_bonus_trigger_round', ''
            ),
            color_order_labels=', '.join(color_order_labels(player.participant)),
            main_card_color_label=main_card_color_label(player.participant),
            inactivity_seconds=player.inactivity_seconds,
            total_task_elapsed_seconds=total_task_elapsed_seconds,
            screen_types_json=json.dumps(
                participant_screen_types(player.participant), indent=2
            ),
            screen_sequence_json=json.dumps(
                participant_screen_sequence(player.participant)
            ),
        )


page_sequence = [DevelopmentSetup, Intro, Decision, InactivityLoss, Results]
