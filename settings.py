from os import environ


SESSION_CONFIGS = [
    dict(
        name='card_stacking',
        display_name='Card Stacking Game',
        app_sequence=['card_stacking'],
        num_demo_participants=1,
        card_num_screens=50,
        inactivity_seconds=30,
    ),
]

SESSION_CONFIG_DEFAULTS = dict(
    real_world_currency_per_point=1.00,
    participation_fee=0.00,
    doc='',
    card_num_screens=50,
    inactivity_seconds=30,
)

PARTICIPANT_FIELDS = [
    'card_stacking_num_screens',
    'card_stacking_inactive',
    'card_stacking_inactive_round',
]
SESSION_FIELDS = [
    'card_stacking_color_order_json',
    'card_stacking_main_color_index',
]

LANGUAGE_CODE = 'en'
REAL_WORLD_CURRENCY_CODE = 'USD'
USE_POINTS = True

ADMIN_USERNAME = 'admin'
ADMIN_PASSWORD = environ.get('OTREE_ADMIN_PASSWORD')

DEMO_PAGE_INTRO_HTML = ''

SECRET_KEY = environ.get('OTREE_SECRET_KEY', 'dev-secret-key-change-before-deployment')
