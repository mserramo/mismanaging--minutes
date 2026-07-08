from otree.api import Bot, Submission
import json

from . import C, Decision, DevelopmentSetup, InactivityLoss, Intro


class PlayerBot(Bot):
    cases = ['complete', 'counters', 'main_complete', 'inactive']

    def _participant_time_finished(self):
        try:
            return self.player.participant.card_stacking_time_finished
        except KeyError:
            return False

    def play_round(self):
        if self._participant_time_finished():
            return

        if self.round_number == 1:
            yield Submission(
                DevelopmentSetup,
                dict(
                    setup_duration_minutes=0.05,
                    setup_show_elapsed_minutes=self.case == 'counters',
                    setup_show_main_cards_collected=self.case == 'counters',
                    setup_click_feedback_ms=C.DEFAULT_CLICK_FEEDBACK_MS,
                ),
                check_html=False,
            )
            assert (
                len(json.loads(self.player.participant.card_stacking_screen_types_json))
                == C.DEFAULT_NUM_SCREEN_TYPES
            )
            assert (
                len(json.loads(self.player.participant.card_stacking_screen_sequence_json))
                == C.NUM_ROUNDS
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
                        timed_out_task_duration=False,
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

        screen_types = json.loads(self.player.participant.card_stacking_screen_types_json)
        screen_sequence = json.loads(
            self.player.participant.card_stacking_screen_sequence_json
        )
        assert self.player.screen_type_index == screen_sequence[self.round_number - 1]
        side_values = screen_types[self.player.screen_type_index - 1]['side_values']
        side_cards = [card for card in cards if not card['is_main']]
        assert [
            dict(x=card['x'], y=card['y'], z=card['z']) for card in side_cards
        ] == side_values

        other_players = [
            player
            for player in self.player.subsession.get_players()
            if player.id_in_group != self.player.id_in_group
        ]
        if self.round_number == 1 and other_players:
            assert self.player.participant.card_stacking_color_order_json
            assert other_players[0].participant.card_stacking_color_order_json

        if self.round_number == 3:
            yield Submission(
                Decision,
                dict(
                    chosen_card_id='',
                    chosen_card_position='',
                    chosen_is_main='',
                    chosen_x='',
                    chosen_y='',
                    chosen_z='',
                    response_time_ms=1000,
                    task_elapsed_ms=3100,
                    timed_out_inactive=False,
                    timed_out_task_duration=True,
                ),
                check_html=False,
            )
            return

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
                timed_out_task_duration=False,
            ),
            check_html=False,
        )
