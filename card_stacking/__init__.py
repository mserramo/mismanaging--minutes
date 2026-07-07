from otree.api import *

import json
import random


doc = """
Card Stacking Game prototype for Mismanaging Minutes.
Participants see a configurable number of card-choice screens. Each screen
records the displayed card parameters, display order, selected card id, and
response time.
"""


class C(BaseConstants):
    NAME_IN_URL = 'card_stacking'
    PLAYERS_PER_GROUP = None
    NUM_ROUNDS = 200
    DEFAULT_NUM_SCREENS = 50

    MAIN_CARD_ID = 'main'

    CARD_DECK = [
        dict(color_id='blue', label='Blue card', color='#2563eb'),
        dict(color_id='green', label='Green card', color='#16a34a'),
        dict(color_id='amber', label='Amber card', color='#f59e0b'),
        dict(color_id='rose', label='Rose card', color='#e11d48'),
        dict(color_id='violet', label='Violet card', color='#7c3aed'),
    ]

    # Placeholder schedule until the final 50 draws are supplied. Y and Z are
    # intentionally separate fields because their relationship is unresolved.
    PLACEHOLDER_SIDE_CARD_VALUES = [
        [
            dict(
                x=4 + ((round_number + card_index) % 9),
                y=5 + ((2 * round_number + card_index) % 20),
                z=1 + ((round_number + card_index) % 4),
            )
            for card_index in range(4)
        ]
        for round_number in range(1, NUM_ROUNDS + 1)
    ]


class Subsession(BaseSubsession):
    pass


class Group(BaseGroup):
    pass


class Player(BasePlayer):
    setup_num_screens = models.IntegerField(
        label='Number of decision screens',
        initial=C.DEFAULT_NUM_SCREENS,
    )

    active_num_screens = models.IntegerField()
    inactivity_seconds = models.IntegerField()

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
    timed_out_inactive = models.BooleanField(initial=False)


def _session_config(player, key, default):
    return player.session.config.get(key, default)


def _extra_field(obj, field_name, default=None):
    try:
        return getattr(obj, field_name)
    except KeyError:
        return default


def _side_values_for_round(round_number):
    return C.PLACEHOLDER_SIDE_CARD_VALUES[round_number - 1]


def active_num_screens(player):
    value = _extra_field(
        player.participant,
        'card_stacking_num_screens',
        _session_config(player, 'card_num_screens', C.DEFAULT_NUM_SCREENS),
    )
    value = int(value)
    if value < 1:
        raise ValueError('Number of decision screens must be at least 1')
    if value > C.NUM_ROUNDS:
        raise ValueError(f'Number of decision screens cannot exceed {C.NUM_ROUNDS}')
    return value


def session_color_order(session):
    color_order_json = _extra_field(session, 'card_stacking_color_order_json')
    if color_order_json:
        return json.loads(color_order_json)
    return list(range(len(C.CARD_DECK)))


def session_main_color_index(session):
    value = _extra_field(session, 'card_stacking_main_color_index')
    if value is None:
        return session_color_order(session)[0]
    return int(value)


def initialize_session_card_randomization(session):
    if _extra_field(session, 'card_stacking_color_order_json'):
        return
    rng = random.Random(f'card-stacking-session-{session.code}')
    color_order = list(range(len(C.CARD_DECK)))
    rng.shuffle(color_order)
    session.card_stacking_color_order_json = json.dumps(color_order)
    session.card_stacking_main_color_index = rng.choice(color_order)


def color_order_labels(session):
    return [
        C.CARD_DECK[color_index]['label'] for color_index in session_color_order(session)
    ]


def main_card_color_label(session):
    return C.CARD_DECK[session_main_color_index(session)]['label']


def format_card_value(value):
    if value is None:
        return ''
    if int(value) == value:
        return str(int(value))
    return f'{value:.1f}'


def add_display_values(card):
    for field_name in ['x', 'y', 'z']:
        card[f'display_{field_name}'] = format_card_value(card.get(field_name))
    return card


def card_from_round(player, card_id):
    if not card_id:
        return None
    cards = json.loads(player.card_params_json)
    return next((card for card in cards if card['id'] == card_id), None)


def build_cards_for_player(player):
    cards = []
    side_values = _side_values_for_round(player.round_number)
    main_color_index = session_main_color_index(player.session)
    side_index = 0

    for color_index in session_color_order(player.session):
        color_card = C.CARD_DECK[color_index]
        card = dict(color_card)
        card.update(round_number=player.round_number)
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
    player.active_num_screens = active_num_screens(player)
    player.inactivity_seconds = int(_session_config(player, 'inactivity_seconds', 30))

    player.visible_card_count = len(cards)
    player.card_ids_json = json.dumps([card['id'] for card in cards])
    player.card_order_json = json.dumps(
        [dict(id=card['id'], position=card['position']) for card in cards]
    )
    player.card_params_json = json.dumps(cards)


def creating_session(subsession):
    initialize_session_card_randomization(subsession.session)
    for player in subsession.get_players():
        if player.round_number == 1:
            player.participant.card_stacking_num_screens = C.DEFAULT_NUM_SCREENS
            player.participant.card_stacking_inactive = False
            player.participant.card_stacking_inactive_round = None
        set_round_fields(player)


def is_inactive(player):
    return bool(_extra_field(player.participant, 'card_stacking_inactive', False))


class DevelopmentSetup(Page):
    form_model = 'player'
    form_fields = ['setup_num_screens']

    @staticmethod
    def is_displayed(player):
        return player.round_number == 1

    @staticmethod
    def error_message(player, values):
        num_screens = values.get('setup_num_screens')
        if num_screens is None:
            return 'Enter the number of decision screens.'
        if num_screens < 1:
            return 'Number of decision screens must be at least 1.'
        if num_screens > C.NUM_ROUNDS:
            return f'Number of decision screens cannot exceed {C.NUM_ROUNDS}.'

    @staticmethod
    def before_next_page(player, timeout_happened):
        player.participant.card_stacking_num_screens = player.setup_num_screens
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
        'timed_out_inactive',
    ]

    @staticmethod
    def is_displayed(player):
        set_round_fields(player)
        return player.round_number <= player.active_num_screens and not is_inactive(player)

    @staticmethod
    def vars_for_template(player):
        cards = json.loads(player.card_params_json)
        cards = [add_display_values(card) for card in cards]
        return dict(
            cards=cards,
            inactivity_seconds=player.inactivity_seconds,
            progress_text=f'Screen {player.round_number} of {player.active_num_screens}',
            round_number=player.round_number,
            task_timer_key=f'card_stacking_task_started_at_{player.participant.code}',
        )

    @staticmethod
    def error_message(player, values):
        timed_out = values.get('timed_out_inactive')
        chosen_card_id = values.get('chosen_card_id')
        if not timed_out and not chosen_card_id:
            return 'Please choose a card.'

    @staticmethod
    def before_next_page(player, timeout_happened):
        if player.timed_out_inactive:
            player.participant.card_stacking_inactive = True
            player.participant.card_stacking_inactive_round = player.round_number
            return

        chosen_card = card_from_round(player, player.chosen_card_id)
        if chosen_card:
            player.chosen_card_position = chosen_card['position']
            player.chosen_is_main = chosen_card['is_main']
            player.chosen_x = chosen_card.get('x')
            player.chosen_y = chosen_card.get('y')
            player.chosen_z = chosen_card.get('z')


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
        return player.round_number == player.active_num_screens and not is_inactive(player)

    @staticmethod
    def vars_for_template(player):
        decisions = []
        for round_player in player.in_all_rounds()[: player.active_num_screens]:
            response_time_ms = round_player.field_maybe_none('response_time_ms')
            chosen_card_id = round_player.field_maybe_none('chosen_card_id')
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
                    response_time_ms=response_time_ms,
                    response_time_seconds=(
                        ''
                        if response_time_ms is None
                        else f'{response_time_ms / 1000:.1f}'
                    ),
                )
            )
        total_task_elapsed_ms = player.field_maybe_none('task_elapsed_ms')
        total_task_elapsed_seconds = (
            ''
            if total_task_elapsed_ms is None
            else f'{total_task_elapsed_ms / 1000:.1f}'
        )
        return dict(
            decisions=decisions,
            active_num_screens=player.active_num_screens,
            color_order_labels=', '.join(color_order_labels(player.session)),
            main_card_color_label=main_card_color_label(player.session),
            inactivity_seconds=player.inactivity_seconds,
            total_task_elapsed_seconds=total_task_elapsed_seconds,
        )


page_sequence = [DevelopmentSetup, Intro, Decision, InactivityLoss, Results]
