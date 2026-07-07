from otree.api import Bot, Submission
import json

from . import Decision, DevelopmentSetup, InactivityLoss, Intro


class PlayerBot(Bot):
    cases = ['complete', 'main_complete', 'inactive']

    def play_round(self):
        active_num_screens = getattr(
            self.player.participant,
            'card_stacking_num_screens',
            self.player.active_num_screens,
        )
        if self.round_number > active_num_screens:
            return

        if self.round_number == 1:
            yield Submission(
                DevelopmentSetup,
                dict(
                    setup_num_screens=5,
                ),
                check_html=False,
            )
            yield Intro

        if self.case == 'inactive':
            if self.round_number == 1:
                yield Submission(
                    Decision,
                    dict(
                        chosen_card_id='',
                        chosen_card_position='',
                        chosen_is_main='',
                        chosen_x='',
                        chosen_y='',
                        chosen_z='',
                        response_time_ms=30000,
                        task_elapsed_ms=30000,
                        timed_out_inactive=True,
                    ),
                    check_html=False,
                )
                yield InactivityLoss
            return

        cards = json.loads(self.player.card_params_json)
        first_round_cards = json.loads(self.player.in_round(1).card_params_json)
        assert [card['color_id'] for card in cards] == [
            card['color_id'] for card in first_round_cards
        ]
        assert next(card['color_id'] for card in cards if card['is_main']) == next(
            card['color_id'] for card in first_round_cards if card['is_main']
        )
        if self.case == 'main_complete':
            chosen_card = next(card for card in cards if card['is_main'])
        else:
            chosen_card = next(card for card in cards if not card['is_main'])
        yield Submission(
            Decision,
            dict(
                chosen_card_id=chosen_card['id'],
                chosen_card_position=chosen_card['position'],
                chosen_is_main=chosen_card['is_main'],
                chosen_x=chosen_card['x'] or '',
                chosen_y=chosen_card['y'] or '',
                chosen_z=chosen_card['z'] or '',
                response_time_ms=1000,
                task_elapsed_ms=self.round_number * 1000,
                timed_out_inactive=False,
            ),
            check_html=False,
        )
