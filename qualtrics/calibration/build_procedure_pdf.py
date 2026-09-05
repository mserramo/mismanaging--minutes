#!/usr/bin/env python3
"""Build the companion guide for the Card Stacking parameter search."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = HERE / "search_config.json"
DEFAULT_RESULTS = HERE / "output"
DEFAULT_OUTPUT = HERE / "output" / "pdf" / "card_stacking_parameter_search_procedure.pdf"

NAVY = colors.HexColor("#17324D")
BLUE = colors.HexColor("#2D6A9F")
LIGHT_BLUE = colors.HexColor("#EAF2F8")
LIGHT_GRAY = colors.HexColor("#F3F5F7")
MID_GRAY = colors.HexColor("#D5DCE3")
DARK = colors.HexColor("#202A34")
MUTED = colors.HexColor("#536273")
GREEN = colors.HexColor("#EAF5EE")
AMBER = colors.HexColor("#FFF5DB")


def styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "Title",
            parent=base["Title"],
            fontName="Helvetica-Bold",
            fontSize=25,
            leading=29,
            textColor=NAVY,
            alignment=TA_LEFT,
            spaceAfter=12,
        ),
        "subtitle": ParagraphStyle(
            "Subtitle",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=12.5,
            leading=18,
            textColor=MUTED,
            spaceAfter=14,
        ),
        "h1": ParagraphStyle(
            "H1",
            parent=base["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=18,
            leading=22,
            textColor=NAVY,
            spaceBefore=8,
            spaceAfter=8,
        ),
        "h2": ParagraphStyle(
            "H2",
            parent=base["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=13.5,
            leading=17,
            textColor=BLUE,
            spaceBefore=8,
            spaceAfter=5,
        ),
        "body": ParagraphStyle(
            "Body",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=10.2,
            leading=14.3,
            textColor=DARK,
            spaceAfter=7,
        ),
        "small": ParagraphStyle(
            "Small",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=8.4,
            leading=11.2,
            textColor=DARK,
        ),
        "table_head": ParagraphStyle(
            "TableHead",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=8.3,
            leading=10.2,
            textColor=colors.white,
            alignment=TA_LEFT,
        ),
        "table": ParagraphStyle(
            "Table",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=7.9,
            leading=10.1,
            textColor=DARK,
        ),
        "equation": ParagraphStyle(
            "Equation",
            parent=base["Code"],
            fontName="Courier",
            fontSize=8.7,
            leading=12,
            leftIndent=10,
            rightIndent=10,
            borderColor=MID_GRAY,
            borderWidth=0.6,
            borderPadding=7,
            backColor=LIGHT_GRAY,
            textColor=DARK,
            spaceBefore=4,
            spaceAfter=9,
        ),
        "callout": ParagraphStyle(
            "Callout",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=10.2,
            leading=14.3,
            textColor=NAVY,
            leftIndent=10,
            rightIndent=10,
            borderColor=BLUE,
            borderWidth=1,
            borderPadding=9,
            backColor=LIGHT_BLUE,
            spaceBefore=5,
            spaceAfter=10,
        ),
        "note": ParagraphStyle(
            "Note",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9.1,
            leading=12.5,
            textColor=DARK,
            leftIndent=9,
            rightIndent=9,
            borderColor=colors.HexColor("#C9A227"),
            borderWidth=0.8,
            borderPadding=8,
            backColor=AMBER,
            spaceBefore=4,
            spaceAfter=9,
        ),
    }


def paragraph(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(text, style)


def bullets(items: list[str], style: ParagraphStyle) -> Table:
    # A two-column table keeps each bullet beside its own paragraph. ReportLab's
    # ListFlowable can place the next bullet at the end of a preceding one-line
    # item in some renderers, which is visually confusing.
    result = Table(
        [
            [Paragraph("<font size='14'>&#8226;</font>", style), Paragraph(item, style)]
            for item in items
        ],
        colWidths=[0.18 * inch, 6.72 * inch],
        hAlign="LEFT",
    )
    result.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (0, -1), 5),
                ("RIGHTPADDING", (1, 0), (1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    result.spaceAfter = 8
    return result


def table(
    rows: list[list[str]],
    widths: list[float],
    style_map: dict[str, ParagraphStyle],
    *,
    header: bool = True,
) -> Table:
    converted = []
    for row_index, row in enumerate(rows):
        converted.append(
            [
                Paragraph(escape(str(value)), style_map["table_head"] if header and row_index == 0 else style_map["table"])
                for value in row
            ]
        )
    result = Table(converted, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    commands = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("GRID", (0, 0), (-1, -1), 0.35, MID_GRAY),
    ]
    if header:
        commands.append(("BACKGROUND", (0, 0), (-1, 0), NAVY))
        commands.append(("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_GRAY]))
    else:
        commands.append(("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, LIGHT_GRAY]))
    result.setStyle(TableStyle(commands))
    return result


def page_header_footer(canvas, doc) -> None:
    canvas.saveState()
    width, height = letter
    canvas.setStrokeColor(MID_GRAY)
    canvas.setLineWidth(0.5)
    canvas.line(doc.leftMargin, height - 0.42 * inch, width - doc.rightMargin, height - 0.42 * inch)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7.8)
    canvas.drawString(doc.leftMargin, height - 0.32 * inch, "MISMANAGING MINUTES - CARD STACKING")
    canvas.drawRightString(width - doc.rightMargin, height - 0.32 * inch, "Parameter search procedure")
    canvas.line(doc.leftMargin, 0.43 * inch, width - doc.rightMargin, 0.43 * inch)
    canvas.drawString(doc.leftMargin, 0.27 * inch, "Offline design aid. It does not modify the survey.")
    canvas.drawRightString(width - doc.rightMargin, 0.27 * inch, f"Page {doc.page}")
    canvas.restoreState()


def load_result_data(config_path: Path, results_dir: Path) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, str]]]:
    config = json.loads(config_path.read_text())
    selected = json.loads((results_dir / "selected_profile.json").read_text())
    with (results_dir / "parameter_profiles_passing.csv").open() as stream:
        passing = list(csv.DictReader(stream))
    return config, selected, passing


def build_story(config: dict[str, Any], selected: dict[str, Any], passing: list[dict[str, str]], s: dict[str, ParagraphStyle]):
    story = []
    rounds = int(config["rounds"])
    movie = int(config["movie_rounds"])
    main = int(config["main_target"])
    side = rounds - movie - main
    metrics = selected["metrics"]
    profile = selected["profile"]

    story.extend(
        [
            Spacer(1, 0.22 * inch),
            Paragraph("Choosing the game parameters", s["title"]),
            Paragraph(
                "A formal, reproducible procedure for finding useful side-task payoffs, drawing probabilities, and Main and Movie bonuses",
                s["subtitle"],
            ),
            Paragraph(
                "This document accompanies <b>search_parameters.py</b>. Its purpose is not to make the procedure sound more complicated than it is. It states what the script varies, what it calculates, what it proves, and what remains a judgment call. The same ideas are repeated in the final checklist so that the reader does not have to remember every definition from its first appearance.",
                s["body"],
            ),
            Paragraph(
                "The central distinction is simple: the payoff ordering is protected by a worst-case mathematical bound. The claims about expected balance and thoughtful sequential choice are based on repeated random draws. The script never calls the latter a proof of optimal sequential behavior.",
                s["callout"],
            ),
            Spacer(1, 0.12 * inch),
            table(
                [
                    ["Current fixed input", "Value", "Meaning"],
                    ["Total rounds", str(rounds), "The participant makes one choice in each round."],
                    ["Movie rounds", str(movie), "Movie is available in the final rounds and must be chosen in all of them to complete Movie."],
                    ["Main target", str(main), "The number of Main choices required to complete Main."],
                    ["Side choices when both are completed", str(side), f"{rounds} - {movie} - {main}. These are the choices available for side tasks."],
                    ["Side cards shown per round", str(config["side_cards_per_round"]), "Exactly four distinct side tasks are shown. Main is additional; Movie is also additional in its phase."],
                ],
                [1.55 * inch, 0.65 * inch, 4.75 * inch],
                s,
            ),
            Spacer(1, 0.12 * inch),
            Paragraph("What the script produces", s["h2"]),
            bullets(
                [
                    "A row for every candidate parameter set, including every pass/fail check and the derived Main and Movie bonuses.",
                    "A second file with one row per candidate and side task, so the value of starting at different rounds, appearance frequency, choices, and payoff contribution can be inspected separately.",
                    "A file containing only candidates that pass all current screens.",
                    "A JSON record of one recommended candidate. This is explicitly marked as a design recommendation, not as a runtime profile.",
                    "A compact PDF table showing every parameter for the highest-ranked profiles, with each symbol explained beside it.",
                ],
                s["body"],
            ),
        ]
    )

    story.extend(
        [
            PageBreak(),
            Paragraph("1. The environment that is being searched", s["h1"]),
            Paragraph(
                "The search keeps the main structure fixed and varies only a bounded set of design choices. There are 100 rounds, four distinct side tasks in every choice set, a Main card in every round, and a Movie card in the final 20 rounds. A participant who completes Main and Movie has 20 choices left for side tasks.",
                s["body"],
            ),
            Paragraph("How ordinary side cards are drawn", s["h2"]),
            Paragraph(
                "Seven side tasks can appear outside an Infinite Scrolling run: two Trios, Fives, two Cumulative tasks, and two Simple tasks. Each has a positive drawing weight. When Infinite Scrolling is not active, the computer draws four different tasks, one after another, without replacement. After one task is drawn, it cannot be drawn again in that round. The remaining tasks retain their relative weights.",
                s["body"],
            ),
            Paragraph(
                "The script calculates the exact probability of every possible four-task set implied by those weights. It also reports the exact probability that each task is included in a round. This matters because a drawing weight is not itself an inclusion probability when four cards are drawn without replacement.",
                s["body"],
            ),
            Paragraph("How Infinite Scrolling is drawn", s["h2"]),
            Paragraph(
                "When no Infinite Scrolling run is active, a run begins with a candidate-specific probability. Its duration is then drawn from 4, 5, 6, or 7 rounds. During those rounds Infinite Scrolling occupies one of the four side-card positions, and three different non-IS tasks are drawn for the remaining positions. After a run ends, the next round cannot start another run. This one-round break keeps two runs from being mistaken for one longer run.",
                s["body"],
            ),
            Paragraph(
                "The generated sequences are never accepted or rejected because of their realized payoffs. Every sequence produced by the stated process remains in the analysis. That preserves the actual distribution generated by the parameters.",
                s["callout"],
            ),
            Paragraph("Payoff rules varied by the search", s["h2"]),
            table(
                [
                    ["Task", "Candidate values considered"],
                    ["Trio A", "25 or 30 points for each three collected."],
                    ["Trio B", "25 or 30 points for each three collected."],
                    ["Fives", "40 or 45 points for each five collected."],
                    ["Cumulative A and B", "A starting payoff, an increase, and a cap. Once the cap is reached, later cards keep paying the cap rather than growing forever."],
                    ["Infinite Scrolling", "A starting payoff and an increase within a consecutive run. Run lengths have short, uniform, or long duration distributions over 4 to 7 rounds."],
                    ["Simple A and B", "Both display 5, 10, or 15 points, but with different fixed probabilities."],
                ],
                [1.65 * inch, 5.3 * inch],
                s,
            ),
            Paragraph(
                "The exact search grid is in search_config.json. Editing that file changes the exercise transparently; no bounds are hidden in the code.",
                s["note"],
            ),
            Paragraph("Keeping the A/B variants genuinely different", s["h2"]),
            Paragraph(
                "Before simulation, the script checks Trio A against Trio B, Cumulative A against Cumulative B, and Simple A against Simple B. A duplicate pair is rejected. A pair passes through a payoff-rule gap of at least five points or a difference greater than 0.10 in the exact probability that the card is included. Simple distributions are compared by total-variation distance after equal payoff amounts are matched. Inclusion probabilities are calculated after four different cards are drawn; raw drawing weights are not treated as inclusion probabilities.",
                s["body"],
            ),
        ]
    )

    story.extend(
        [
            PageBreak(),
            Paragraph("2. How candidate parameter sets are made", s["h1"]),
            Paragraph(
                "A full Cartesian product would waste time on an enormous number of combinations. Instead, the script draws a fixed number of unique candidates from the bounded grid. The random seed is fixed, so the same configuration produces the same candidates in the same order.",
                s["body"],
            ),
            Paragraph(
                "The seven non-IS drawing weights are multiples of 0.05 and sum to 1.00. The configuration places lower and upper bounds on each weight. For every candidate, the script also chooses one allowed Trio bonus, Fives bonus, Cumulative rule, IS payoff rule, IS start probability, and IS duration distribution.",
                s["body"],
            ),
            Paragraph(
                "This is a bounded exploration, not a claim that the grid contains every sensible design. Its job is to show which regions look promising and which constraints are binding. If the passing set is empty or uninteresting, the right response is to widen or move the bounds and rerun the same procedure.",
                s["callout"],
            ),
            Paragraph("Why the numbers are restricted", s["h2"]),
            Paragraph(
                "Probabilities and bonuses are restricted to values that are easy to state to participants. The restriction also prevents the search from finding a fragile solution that depends on an awkward number such as a 0.137 probability or a 37-point bonus. Main and Movie bonuses are rounded upward to the nearest five after the safety calculation is complete.",
                s["body"],
            ),
            Paragraph("Reproducibility", s["h2"]),
            Paragraph(
                "Each candidate, sequence, and random-policy repetition receives a seed derived from the master seed and its identifiers. Therefore two runs with the same configuration produce byte-for-byte identical CSV files. The manifest records a SHA-256 fingerprint for the configuration and each output. These fingerprints are only checks that files have not changed; they do not affect the economics and are not shown to participants.",
                s["body"],
            ),
        ]
    )

    story.extend(
        [
            PageBreak(),
            Paragraph("3. What it is worth to start each side task", s["h1"]),
            Paragraph(
                "The old calculation asked how much a task could pay after looking at the entire sequence and taking its best twenty opportunities. That was useful for a full-information benchmark, but it was not the value faced by a participant in the sequential treatment. It has been removed from the screen.",
                s["body"],
            ),
            Paragraph(
                "The replacement repeats one simple question at every ordinary round: if this card is displayed now and the participant begins it with no earlier progress, how many points per selected card would beginning it now produce? The script conditions on the card being displayed, calculates that value in every simulated sequence, averages across those sequences for the round, and finally gives each of rounds 1 through 80 equal weight.",
                s["callout"],
            ),
            Paragraph("How the calculation treats each task", s["h2"]),
            bullets(
                [
                    "Simple: use the payoff printed on the card. Averaging across draws recovers the displayed-payoff distribution without allowing the participant to choose only the largest future realizations.",
                    "Trio and Fives: look from the current round to round 80. If enough cards of that same task remain to finish one new group, use the group bonus divided by three or five. If the group cannot be finished, use zero. Averaging therefore includes the probability that a new group can still be completed.",
                    "Cumulative: count how many cards of that task remain from the current round, up to the twenty-choice side budget. Add the capped marginal payoffs for those cards and divide by the number of cards. Across draws, this averages the cases in which only one, two, three, or more future cards are available.",
                    "Infinite Scrolling: count the cards left in the current run before round 81, add the consecutive-run payoffs from a fresh start, and divide by those cards. Every IS card pays immediately, so the calculation does not invent a separate completion bonus that the task does not have.",
                ],
                s["body"],
            ),
            Paragraph(
                "start value of task j = average across ordinary rounds of the expected points per selected card from beginning j in that round, conditional on j being displayed",
                s["equation"],
            ),
            Paragraph("The balance screen", s["h2"]),
            Paragraph(
                "For each candidate, the script divides the largest round-averaged start value by the smallest. The candidate passes if this ratio is no more than 1.25. A ratio of 1.25 means that the highest value of beginning a displayed task is estimated to be at most 25 percent larger than the lowest after the same round-by-round comparison is applied to every task.",
                s["body"],
            ),
            Paragraph(
                "This calculation is deliberately conditional on the card being displayed. Appearance frequency is reported separately and affects the probability that a Trio or Fives group can be completed. The measure is not an allocation policy, and hypothetical starts from different rounds must not be added together as if one participant could take all of them.",
                s["note"],
            ),
            Paragraph(
                "The fresh-start assumption is important. It does not value a participant who is already one card away from a Trio bonus or partway through a Cumulative task. The separate planning-policy simulation below retains that evolving task state.",
                s["body"],
            ),
        ]
    )

    story.extend(
        [
            PageBreak(),
            Paragraph("4. The worst-case Main and Movie guarantee", s["h1"]),
            Paragraph(
                "The robust payoff ordering is handled differently. It is not tested on a bank of random sequences. Instead, the script constructs an upper bound on side-task pay that covers every sequence allowed by the positive-probability supports, including extreme sequences that are very unlikely.",
                s["body"],
            ),
            Paragraph("The payoff from assigning n choices to one task", s["h2"]),
            Paragraph(
                "For each task j, define F_j(n) as the largest payoff that n choices could produce under that task's allowed payoff support. Simple tasks use their highest possible displayed payoff every time. Cumulative tasks use their capped schedule. Infinite Scrolling uses the longest allowed runs. Trio and Fives use the exact number of complete groups.",
                s["body"],
            ),
            Paragraph("F_j(n) = maximum support-level payoff from n choices assigned to task j", s["equation"]),
            Paragraph("Allowing mixtures across side tasks", s["h2"]),
            Paragraph(
                "The script does not assume that all side choices go to one task. It solves a small allocation problem over all eight tasks. If k choices are available for side tasks, it divides those k choices in every possible way across the tasks and keeps the largest sum of F_j values.",
                s["body"],
            ),
            Paragraph("U(k) = max sum_j F_j(n_j), subject to sum_j n_j <= k and n_j >= 0", s["equation"]),
            Paragraph(
                "This directly handles the example in which complete Trios leave one unused choice: the remaining choice may be assigned to a Simple, Cumulative, IS, or another task if that raises the bound. The calculation is a small dynamic program, not a greedy sort by average payoff.",
                s["body"],
            ),
            Paragraph(
                "Availability restrictions are ignored in U(k). This can combine favorable side-task opportunities that may not all fit into one actual sequence. That is why U(k) is conservative: it can be too high, but it cannot be too low merely because the script forgot an allowed draw.",
                s["callout"],
            ),
        ]
    )

    story.extend(
        [
            PageBreak(),
            Paragraph("5. Deriving B and M", s["h1"]),
            Paragraph(
                "The four completion regimes leave different numbers of choices for side tasks. With the current 100/60/20 design, completing both leaves 20 side choices; completing Main only leaves 40; completing Movie only leaves 80; completing neither leaves 100.",
                s["body"],
            ),
            table(
                [
                    ["Regime", "Side-choice budget", "Guaranteed threshold pay"],
                    ["Both", "R - Q - R_M = 20", "B + M"],
                    ["Main only", "R - Q = 40", "B"],
                    ["Movie only", "R - R_M = 80", "M"],
                    ["Neither", "R = 100", "0"],
                ],
                [1.5 * inch, 2.4 * inch, 2.6 * inch],
                s,
            ),
            Spacer(1, 0.1 * inch),
            Paragraph(
                "For the lower side of each comparison, the certificate counts no side-task payoff. For the upper side, it allows the full U(k) bound. This is the source of the conservatism noticed in our earlier discussion: a participant who completes Main or Movie will usually earn side-task points too, but the proof does not rely on them.",
                s["body"],
            ),
            Paragraph("Current bonus rule", s["h2"]),
            Paragraph(
                "Let rho be the requested proportional cushion, g the small absolute gap, and ceil_5 mean round upward to the nearest five. The script uses rho = 0.20 and g = 5.",
                s["body"],
            ),
            Paragraph(
                "M = ceil_5( max{(1 + rho) U(40), (1 + rho) U(100)} + g )<br/>"
                "B = ceil_5( M + (1 + rho) U(80) + g )",
                s["equation"],
            ),
            Paragraph(
                "The first line makes Movie large enough to beat the side-pay opportunity forgone when moving from neither to Movie only, and also when moving from Main only to both. The second line makes Main only beat Movie only after allowing Movie only its worst-case side-pay upper bound.",
                s["body"],
            ),
            Paragraph("What this proves", s["h2"]),
            Paragraph(
                "For every sequence allowed by the payoff supports, the following strict ordering holds under the bound:",
                s["body"],
            ),
            Paragraph("B + M + V_11  >  B + V_10  >  M + V_01  >  V_00", s["equation"]),
            Paragraph(
                "The CSV reports each guaranteed point gap and the corresponding percentage gap between the two total payoffs. The 20 percent cushion applies to the side-pay opportunity being covered. It does not automatically make every total payoff 20 percent larger than the next total. Those total-payoff percentages are reported separately so this distinction is visible.",
                s["note"],
            ),
        ]
    )

    story.extend(
        [
            PageBreak(),
            Paragraph("6. Does planning help in the sequential treatment?", s["h1"]),
            Paragraph(
                "The robust certificate says nothing about whether the side-task problem is interesting. The script therefore compares two policies that both protect Main and Movie. Neither policy knows future cards.",
                s["body"],
            ),
            Paragraph("The random comparison", s["h2"]),
            Paragraph(
                "In the first 80 rounds, the random policy uses exactly 20 choices for side tasks and 60 for Main. At each round it chooses whether to spend a remaining side choice with probability equal to side choices remaining divided by ordinary rounds remaining. When it chooses a side task, it picks uniformly from the four displayed side cards. It chooses Movie in every Movie round.",
                s["body"],
            ),
            Paragraph("The planning comparison", s["h2"]),
            Paragraph(
                "The planning policy also reserves exactly 60 Main choices and all 20 Movie choices. It values a Trio by its bonus divided by three, Fives by its bonus divided by five, a Cumulative card by its current capped marginal payoff, an IS card by its current within-run payoff, and a Simple card by the amount printed on it. A reference distribution of current-round scores determines how selective the policy should be when it still has many rounds left.",
                s["body"],
            ),
            Paragraph(
                "The policy reacts only to cards already seen, current task progress, choices remaining, and rounds remaining. It does not inspect future cards or the completed sequence.",
                s["callout"],
            ),
            Paragraph("The current pass rule", s["h2"]),
            Paragraph(
                "For every simulated sequence, the planning payoff is paired with the average payoff from several random-policy repetitions on that same sequence. The candidate passes if the mean planning advantage is at least 10 percent of the random-policy mean and the lower end of a conventional 95 percent interval for the paired point difference is above zero.",
                s["body"],
            ),
            Paragraph(
                "This is evidence that purposeful allocation matters. It is not proof that the planning policy is the best possible sequential policy. Proving that stronger statement would require an exact stochastic dynamic program or an equivalent nonanticipating optimization. The output repeats this warning in a dedicated status column.",
                s["note"],
            ),
        ]
    )

    story.extend(
        [
            PageBreak(),
            Paragraph("7. Does the side-task mix vary across draws?", s["h1"]),
            Paragraph(
                "The script records which tasks receive the planning policy's 20 side choices in every simulated sequence. It does not add separate tests for which task most often has the largest contribution or the highest conditional selection rate. Those measures were overlapping, sensitive to appearance frequency, and did not correspond to an additional design requirement.",
                s["body"],
            ),
            Paragraph("Change in the task mix", s["h2"]),
            Paragraph(
                "For each sequence, the 20 choices are converted to shares across the eight side tasks. The script compares that eight-number mix with the average mix across all sequences. Half of the absolute differences is the share of side choices that would have to move between tasks to turn the sequence-specific mix into the average mix.",
                s["body"],
            ),
            Paragraph(
                "mean change in task mix = average over sequences of 0.5 * sum_j |share_j - mean_share_j|",
                s["equation"],
            ),
            Paragraph(
                "The current threshold is 0.10. With twenty side choices, that corresponds to roughly two choices moving between task types in an average sequence. This is a deliberately modest first-pass threshold, and the CSV retains the underlying number so it can be tightened later.",
                s["body"],
            ),
            Paragraph(
                "A candidate passing this screen shows sequence-dependent behavior for this specified planning policy. It still does not establish that the exact sequential optimum changes across sequences. That stronger claim remains a later verification task for a short list of candidates.",
                s["callout"],
            ),
        ]
    )

    selected_rows = [
        ["Measure", "Selected candidate"],
        ["Profile ID", str(profile["profile_id"])],
        ["Start-now value ratio", f"{float(metrics['start_now_value_ratio']):.3f}"],
        ["Planning side pay", f"{float(metrics['planning_policy_mean_side_pay']):.1f}"],
        ["Random side pay", f"{float(metrics['random_policy_mean_side_pay']):.1f}"],
        ["Planning gain over random", f"{100 * float(metrics['planning_gain_over_random']):.1f}%"],
        ["Mean change in task mix", f"{100 * float(metrics['mean_change_in_task_mix']):.1f}% of side choices"],
        ["Derived Main bonus B", str(metrics["derived_main_bonus"])],
        ["Derived Movie bonus M", str(metrics["derived_movie_bonus"])],
    ]
    story.extend(
        [
            PageBreak(),
            Paragraph("8. Which candidates survive", s["h1"]),
            Paragraph(
                "A candidate is placed in parameter_profiles_passing.csv only if all five statements below are true.",
                s["body"],
            ),
            bullets(
                [
                    "Each A/B pair passes the meaningful-difference rule before simulation.",
                    "Its largest round-averaged start-now value is no more than 1.25 times its smallest.",
                    "The planning policy beats the random comparison by at least 10 percent, and the paired lower 95 percent bound is positive.",
                    "The average task mix changes by at least 0.10 across draws.",
                    "The derived Main and Movie bonuses pass the conservative worst-case ordering proof.",
                ],
                s["body"],
            ),
            Paragraph(
                f"The included run evaluated {config['candidate_count']} candidates and found {len(passing)} that passed all current screens.",
                s["callout"],
            ),
            Paragraph("One automatically selected candidate", s["h2"]),
            table(selected_rows, [3.5 * inch, 3.0 * inch], s),
            Spacer(1, 0.1 * inch),
            Paragraph(
                "Passing candidates are listed first. Within pass/fail status, the review order favors a smaller start-now value ratio, a larger planning advantage, more sequence-to-sequence change in the chosen task mix, and then a smaller sum of B and M. This is a review order, not an economic theorem. Every other row remains in the CSV and the best-profile PDF.",
                s["body"],
            ),
        ]
    )

    task_rows = [["Task", "Weight or rule in selected candidate"]]
    for task_id, weight in profile["non_is_weights"].items():
        task_rows.append([task_id, f"non-IS draw weight {weight:.2f}"])
    task_rows.extend(
        [
            ["Infinite Scrolling", f"start probability {profile['is_start_probability']:.2f}; {profile['is_duration_name']} duration distribution; payoff starts at {profile['infinite_scroll']['start']} and rises by {profile['infinite_scroll']['increase']}"],
            ["Cumulative A", f"starts at {profile['cumulative']['cumulative_a']['start']}; rises by {profile['cumulative']['cumulative_a']['increase']}; capped at {profile['cumulative']['cumulative_a']['cap']}"],
            ["Cumulative B", f"starts at {profile['cumulative']['cumulative_b']['start']}; rises by {profile['cumulative']['cumulative_b']['increase']}; capped at {profile['cumulative']['cumulative_b']['cap']}"],
        ]
    )
    story.extend(
        [
            PageBreak(),
            Paragraph("9. Reading the selected candidate", s["h1"]),
            Paragraph(
                "The selected JSON is intentionally verbose. It contains the candidate's draw weights, all payoff rules, the recommended B and M, the pass/fail results, and the warning that the file has not been installed in Qualtrics.",
                s["body"],
            ),
            table(task_rows, [1.7 * inch, 5.25 * inch], s),
            Spacer(1, 0.1 * inch),
            Paragraph("What should be reviewed before implementation", s["h2"]),
            bullets(
                [
                    "Whether the implied inclusion probabilities, not merely the raw weights, are easy to explain and scientifically appropriate.",
                    "Whether a roughly 25 percent range in the value of beginning a displayed task is genuinely close enough for the design goal.",
                    "Whether the Main and Movie bonuses are acceptable after conversion from experimental points to money. Their absolute size is not meaningful until that conversion is chosen.",
                    "Whether the sequence-to-sequence variation is large enough to make the treatment informative rather than merely statistically detectable.",
                    "Whether the capped Cumulative and bounded IS rules are intuitive in the participant instructions.",
                ],
                s["body"],
            ),
        ]
    )

    story.extend(
        [
            PageBreak(),
            Paragraph("10. Files and commands", s["h1"]),
            Paragraph("Run the search from the repository root:", s["body"]),
            Paragraph("python3 qualtrics/calibration/search_parameters.py", s["equation"]),
            Paragraph("Run a quick check on only the first twelve candidates:", s["body"]),
            Paragraph("python3 qualtrics/calibration/search_parameters.py --limit 12 --output-dir /tmp/card-calibration", s["equation"]),
            Paragraph("Rebuild this guide after rerunning the search:", s["body"]),
            Paragraph("python3 qualtrics/calibration/build_procedure_pdf.py", s["equation"]),
            Paragraph("Build the compact table of the highest-ranked profiles:", s["body"]),
            Paragraph("python3 qualtrics/calibration/build_best_profiles_pdf.py", s["equation"]),
            table(
                [
                    ["File", "Contents"],
                    ["search_config.json", "Editable bounds, fixed inputs, simulation counts, seed, and pass thresholds."],
                    ["parameter_profiles.csv", "Every candidate and all profile-level calculations, including failures."],
                    ["parameter_task_metrics.csv", "One row per candidate and task, with start-now value summaries, appearances, policy choices, and payoff contribution."],
                    ["parameter_profiles_passing.csv", "Only candidates that satisfy all current screens."],
                    ["selected_profile.json", "One recommended candidate plus an explicit warning that it is not a runtime profile."],
                    ["search_manifest.json", "Run count and SHA-256 fingerprints for reproducibility."],
                    ["best_parameter_profiles.pdf", "Every parameter for the highest-ranked profiles, with symbols and plain-language definitions."],
                ],
                [2.2 * inch, 4.75 * inch],
                s,
            ),
            Spacer(1, 0.1 * inch),
            Paragraph(
                "None of these commands changes environment_profile.json, certified_environment_bank.json, the validation CSVs used by the survey, the QSF, or the JavaScript runtime.",
                s["callout"],
            ),
        ]
    )

    story.extend(
        [
            PageBreak(),
            Paragraph("11. What is proved, and what is not", s["h1"]),
            Paragraph("Proved by the current script", s["h2"]),
            bullets(
                [
                    "The subset probabilities induced by each candidate's weighted drawing rule are calculated exactly.",
                    "Every generated sequence follows the stated unfiltered process, always has four distinct side tasks, and respects the selected IS duration support.",
                    "The U(k) calculation considers mixtures across all side tasks and provides a support-level upper bound for any allowed sequence.",
                    "The derived B and M establish both > Main only > Movie only > neither under that conservative bound.",
                    "The outputs are deterministic for a fixed configuration and seed.",
                ],
                s["body"],
            ),
            Paragraph("Estimated from repeated draws", s["h2"]),
            bullets(
                [
                    "The round-by-round value per selected card of beginning each displayed side task with no earlier progress.",
                    "The payoff difference between the planning and random policies.",
                    "How much the planning policy's chosen task mix changes across sequences.",
                ],
                s["body"],
            ),
            Paragraph("Not established yet", s["h2"]),
            bullets(
                [
                    "That the implemented planning policy is the mathematically optimal sequential policy.",
                    "That the exact optimal sequential bundle changes across draws, rather than merely the bundle chosen by this reasonable policy.",
                    "That the conservative B and M are the smallest bonuses that work. They are safe upper recommendations and may be lowered by a same-environment adversarial calculation.",
                    "That the automatically selected candidate is substantively best. It is the first candidate to review, not the final design decision.",
                ],
                s["body"],
            ),
            Paragraph(
                "The next rigorous step, after choosing a short list, is to solve the exact sequential decision problem for those few profiles and to replace the availability-free U(k) bound with a tighter adversarial calculation that respects the same environment across all four completion regimes. That is intentionally not hidden inside this first screening script.",
                s["note"],
            ),
        ]
    )

    story.extend(
        [
            PageBreak(),
            Paragraph("Appendix: the procedure in one pass", s["h1"]),
            table(
                [
                    ["Step", "What happens", "Why"],
                    ["1", "Read fixed inputs and a small grid of allowed values.", "Keep the search understandable and computationally manageable."],
                    ["2", "Build a reproducible set of unique candidate profiles.", "Explore many plausible designs without pretending to search every real number."],
                    ["3", "Calculate exact one-round set and inclusion probabilities.", "Translate drawing weights into the probabilities that participants actually face."],
                    ["4", "Draw many full sequences without rejecting any of them.", "Preserve the distribution implied by the parameters."],
                    ["5", "At every ordinary round, estimate the value per card of beginning each displayed task; then average rounds equally.", "Remove profiles in which one side task is much more attractive to begin than another."],
                    ["6", "Run the planning and random policies on the same sequences.", "Measure whether allocating side choices deliberately has material value."],
                    ["7", "Measure how the twenty-choice task mix changes across draws.", "Check whether realized cards alter useful side-task allocation."],
                    ["8", "Calculate U(k) for all four side-choice budgets.", "Cover extreme allowed draws and mixtures across task types."],
                    ["9", "Derive nice-number B and M and verify the strict ordering.", "Guarantee both > Main only > Movie only > neither without filtering sequences."],
                    ["10", "Write all candidates, passing candidates, task details, and a recommended row.", "Make the judgment reviewable rather than burying it in code."],
                ],
                [0.45 * inch, 3.3 * inch, 3.2 * inch],
                s,
            ),
            Spacer(1, 0.15 * inch),
            Paragraph(
                "The short version: simulate to learn whether the side-task design is balanced and interesting; use a conservative bound to guarantee the Main/Movie ordering; keep the two kinds of evidence separate.",
                s["callout"],
            ),
        ]
    )
    return story


def build_pdf(config_path: Path, results_dir: Path, output_path: Path) -> None:
    config, selected, passing = load_result_data(config_path, results_dir)
    style_map = styles()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    doc = BaseDocTemplate(
        str(output_path),
        pagesize=letter,
        leftMargin=0.62 * inch,
        rightMargin=0.62 * inch,
        topMargin=0.62 * inch,
        bottomMargin=0.58 * inch,
        title="Card Stacking parameter search procedure",
        author="Mismanaging Minutes project",
        subject="Formal procedure for parameter search, diagnostics, and robust payoff certification",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="body")
    doc.addPageTemplates(PageTemplate(id="main", frames=[frame], onPage=page_header_footer))
    doc.build(build_story(config, selected, passing, style_map))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--results-dir", type=Path, default=DEFAULT_RESULTS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    build_pdf(args.config.resolve(), args.results_dir.resolve(), args.output.resolve())
    print(args.output.resolve())


if __name__ == "__main__":
    main()
