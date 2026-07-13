from otree.api import Bot, Submission
import json

from . import C, Decision, DevelopmentSetup, InactivityLoss, Intro


class PlayerBot(Bot):
    cases = ['complete', 'counters', 'main_complete', 'inactive']
    test_bonus_threshold = 2
    test_main_bonus_points = 30

    def _participant_time_finished(self):
        try:
            return self.player.participant.card_stacking_time_finished
        except KeyError:
            return False

    def _participant_points(self):
        try:
            return self.player.participant.card_stacking_points_accumulated
        except KeyError:
            return 0

    def _participant_bonus_triggered(self):
        try:
            return self.player.participant.card_stacking_main_bonus_triggered
        except KeyError:
            return False

    def _previous_main_count(self):
        return sum(
            1
            for previous_player in self.player.in_previous_rounds()
            if previous_player.field_maybe_none('chosen_is_main')
        )

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
                    setup_show_total_points=True,
                    setup_show_click_feedback=True,
                    setup_feedback_message_ms=C.DEFAULT_FEEDBACK_MESSAGE_MS,
                    setup_use_post_click_delay=False,
                    setup_click_feedback_ms=C.DEFAULT_CLICK_FEEDBACK_MS,
                    setup_main_bonus_feedback_ms=C.DEFAULT_MAIN_BONUS_FEEDBACK_MS,
                    setup_screen_motion_ms=C.DEFAULT_SCREEN_MOTION_MS,
                    setup_bonus_threshold_main_cards=self.test_bonus_threshold,
                    setup_main_bonus_points=self.test_main_bonus_points,
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
                        points_before=self._participant_points(),
                        card_points_added='',
                        multiplier_applied='',
                        multiplier_y='',
                        multiplier_z='',
                        main_bonus_triggered_this_round=False,
                        main_bonus_points_added='',
                        points_after=self._participant_points(),
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
                    points_before=self._participant_points(),
                    card_points_added='',
                    multiplier_applied='',
                    multiplier_y='',
                    multiplier_z='',
                    main_bonus_triggered_this_round=False,
                    main_bonus_points_added='',
                    points_after=self._participant_points(),
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
        points_before = self._participant_points()
        card_points_added = 0 if chosen_card['is_main'] else chosen_card['x']
        main_bonus_triggered = (
            chosen_card['is_main']
            and not self._participant_bonus_triggered()
            and self._previous_main_count() + 1 >= self.test_bonus_threshold
        )
        main_bonus_points_added = (
            self.test_main_bonus_points if main_bonus_triggered else 0
        )
        points_after = points_before + card_points_added + main_bonus_points_added
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
                points_before=points_before,
                card_points_added=card_points_added,
                multiplier_applied=False,
                multiplier_y='' if chosen_card['is_main'] else chosen_card['y'],
                multiplier_z='' if chosen_card['is_main'] else chosen_card['z'],
                main_bonus_triggered_this_round=main_bonus_triggered,
                main_bonus_points_added=main_bonus_points_added,
                points_after=points_after,
                timed_out_inactive=False,
                timed_out_task_duration=False,
            ),
            check_html=False,
        )
