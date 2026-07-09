from os import environ


SESSION_CONFIGS = [
    dict(
        name='card_stacking',
        display_name='Card Stacking Game',
        app_sequence=['card_stacking'],
        num_demo_participants=1,
        inactivity_seconds=30,
        num_screen_types=50,
        screen_types_file='screen_types.txt',
    ),
]

SESSION_CONFIG_DEFAULTS = dict(
    real_world_currency_per_point=1.00,
    participation_fee=0.00,
    doc='',
    inactivity_seconds=30,
    num_screen_types=50,
    screen_types_file='screen_types.txt',
)

PARTICIPANT_FIELDS = [
    'card_stacking_color_order_json',
    'card_stacking_main_color_index',
    'card_stacking_task_duration_minutes',
    'card_stacking_num_screen_types',
    'card_stacking_screen_types_json',
    'card_stacking_screen_sequence_json',
    'card_stacking_show_elapsed_minutes',
    'card_stacking_show_main_cards_collected',
    'card_stacking_show_click_feedback',
    'card_stacking_use_post_click_delay',
    'card_stacking_click_feedback_ms',
    'card_stacking_main_bonus_feedback_ms',
    'card_stacking_bonus_threshold_main_cards',
    'card_stacking_main_bonus_points',
    'card_stacking_points_accumulated',
    'card_stacking_main_bonus_triggered',
    'card_stacking_main_bonus_trigger_round',
    'card_stacking_inactive',
    'card_stacking_inactive_round',
    'card_stacking_time_finished',
    'card_stacking_time_finished_round',
    'card_stacking_pending_feedback_json',
]
SESSION_FIELDS = []

LANGUAGE_CODE = 'en'
REAL_WORLD_CURRENCY_CODE = 'USD'
USE_POINTS = True

ADMIN_USERNAME = 'admin'
ADMIN_PASSWORD = environ.get('OTREE_ADMIN_PASSWORD')

DEMO_PAGE_INTRO_HTML = ''

SECRET_KEY = environ.get('OTREE_SECRET_KEY', 'dev-secret-key-change-before-deployment')
