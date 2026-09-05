#!/usr/bin/env python3
"""Build a compact, readable table of the highest-ranked parameter profiles."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any, Mapping, Sequence
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
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
DEFAULT_OUTPUT = HERE / "output" / "pdf" / "best_parameter_profiles.pdf"

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
            fontSize=20,
            leading=23,
            textColor=NAVY,
            alignment=TA_LEFT,
            spaceAfter=5,
        ),
        "subtitle": ParagraphStyle(
            "Subtitle",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9.2,
            leading=12,
            textColor=MUTED,
            spaceAfter=7,
        ),
        "head": ParagraphStyle(
            "Head",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=6.8,
            leading=7.7,
            textColor=colors.white,
        ),
        "cell": ParagraphStyle(
            "Cell",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=6.4,
            leading=7.2,
            textColor=DARK,
        ),
        "cell_bold": ParagraphStyle(
            "CellBold",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=6.4,
            leading=7.2,
            textColor=DARK,
        ),
        "section": ParagraphStyle(
            "Section",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=6.6,
            leading=7.4,
            textColor=NAVY,
        ),
    }


def page_header_footer(canvas, doc) -> None:
    canvas.saveState()
    width, height = landscape(letter)
    canvas.setStrokeColor(MID_GRAY)
    canvas.setLineWidth(0.5)
    canvas.line(doc.leftMargin, 0.38 * inch, width - doc.rightMargin, 0.38 * inch)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7.4)
    canvas.drawString(doc.leftMargin, 0.22 * inch, "MISMANAGING MINUTES - PARAMETER REVIEW")
    canvas.drawRightString(width - doc.rightMargin, 0.22 * inch, f"Page {doc.page}")
    canvas.restoreState()


def load_rows(config_path: Path, results_dir: Path) -> tuple[dict[str, Any], list[dict[str, str]]]:
    config = json.loads(config_path.read_text())
    with (results_dir / "parameter_profiles.csv").open(encoding="utf-8") as stream:
        rows = list(csv.DictReader(stream))
    if not rows:
        raise ValueError("parameter_profiles.csv contains no parameter profiles")
    return config, rows


def format_number(value: Any, digits: int = 2) -> str:
    number = float(value)
    if number.is_integer():
        return str(int(number))
    return f"{number:.{digits}f}"


def distribution_text(items: Sequence[Mapping[str, Any]]) -> str:
    return "; ".join(
        f"{format_number(item['points'])} pts @ {float(item['probability']):.2f}"
        for item in items
    )


def duration_text(probabilities: Mapping[str, Any]) -> str:
    return "; ".join(
        f"L={length}: {float(probability):.2f}"
        for length, probability in sorted(probabilities.items(), key=lambda item: int(item[0]))
    )


def parameter_rows(config: Mapping[str, Any], row: Mapping[str, str]) -> list[tuple[str, str, str, str]]:
    profile = json.loads(row["candidate_json"])
    weights = profile["non_is_weights"]
    cumulative = profile["cumulative"]
    infinite = profile["infinite_scroll"]
    simple = profile["simple_tasks"]
    durations = profile["is_duration_probabilities"]

    result: list[tuple[str, str, str, str]] = []

    def add(section: str, symbol: str, meaning: str, value: Any) -> None:
        result.append((section, symbol, meaning, str(value)))

    add("Drawing weights", "w_TA", "Trio A weight when no IS run is active", f"{weights['trio_a']:.2f}")
    add("Drawing weights", "w_TB", "Trio B weight when no IS run is active", f"{weights['trio_b']:.2f}")
    add("Drawing weights", "w_F", "Fives weight when no IS run is active", f"{weights['fives']:.2f}")
    add("Drawing weights", "w_CA", "Cumulative A weight when no IS run is active", f"{weights['cumulative_a']:.2f}")
    add("Drawing weights", "w_CB", "Cumulative B weight when no IS run is active", f"{weights['cumulative_b']:.2f}")
    add("Drawing weights", "w_SA", "Simple A weight when no IS run is active", f"{weights['simple_a']:.2f}")
    add("Drawing weights", "w_SB", "Simple B weight when no IS run is active", f"{weights['simple_b']:.2f}")

    add("Group payoffs", "b_TA", "Points for each completed Trio A group", profile["group_bonuses"]["trio_a"])
    add("Group payoffs", "b_TB", "Points for each completed Trio B group", profile["group_bonuses"]["trio_b"])
    add("Group payoffs", "b_F", "Points for each completed Fives group", profile["group_bonuses"]["fives"])

    for suffix, task_id in (("CA", "cumulative_a"), ("CB", "cumulative_b")):
        add("Cumulative rules", f"a_{suffix}", f"{suffix} payoff on its first selected card", cumulative[task_id]["start"])
        add("Cumulative rules", f"d_{suffix}", f"{suffix} increase after each selected card", cumulative[task_id]["increase"])
        add("Cumulative rules", f"c_{suffix}", f"{suffix} maximum marginal payoff", cumulative[task_id]["cap"])

    add("Infinite Scrolling", "a_IS", "IS payoff on the first consecutive card", infinite["start"])
    add("Infinite Scrolling", "d_IS", "IS increase for each consecutive selected card", infinite["increase"])
    add("Infinite Scrolling", "p_IS", "Probability that an IS run starts when eligible", f"{profile['is_start_probability']:.2f}")
    add("Infinite Scrolling", "D_IS", "Name of the IS run-length distribution", profile["is_duration_name"])
    add("Infinite Scrolling", "Pr(L)", "Probabilities for each allowed IS run length", duration_text(durations))

    add("Simple tasks", "X_SA", "Simple A displayed payoff distribution", distribution_text(simple["simple_a"]))
    add("Simple tasks", "X_SB", "Simple B displayed payoff distribution", distribution_text(simple["simple_b"]))

    add("Derived bonuses", "B", "Main-task bonus recommended by the robust certificate", row["derived_main_bonus"])
    add("Derived bonuses", "M", "Movie-task bonus recommended by the robust certificate", row["derived_movie_bonus"])

    add("Review diagnostics", "Pass", "Whether all current screens are satisfied", "Yes" if row["meets_all_targets"] == "True" else "No")
    add("Review diagnostics", "r_start", "Largest/smallest round-averaged start-now value", f"{float(row['start_now_value_ratio']):.3f}")
    add("Review diagnostics", "g_plan", "Planning side-pay gain over random allocation", f"{100 * float(row['planning_gain_over_random']):.1f}%")
    add("Review diagnostics", "d_mix", "Mean share of side choices moved across sequences", f"{100 * float(row['mean_change_in_task_mix']):.1f}%")
    return result


def common_inputs(config: Mapping[str, Any]) -> list[list[str]]:
    side = int(config["rounds"]) - int(config["movie_rounds"]) - int(config["main_target"])
    return [
        ["R", "Total rounds", str(config["rounds"])],
        ["R_M", "Movie rounds", str(config["movie_rounds"])],
        ["Q", "Main choices required", str(config["main_target"])],
        ["S", "Side choices left when Main and Movie are completed", str(side)],
        ["K", "Distinct side cards shown each round", str(config["side_cards_per_round"])],
    ]


def fixed_input_table(config: Mapping[str, Any], style_map: Mapping[str, ParagraphStyle]) -> Table:
    rows = [["Symbol", "Fixed input", "Value"]] + common_inputs(config)
    converted = []
    for row_index, row in enumerate(rows):
        style = style_map["head"] if row_index == 0 else style_map["cell"]
        converted.append([Paragraph(escape(value), style) for value in row])
    result = Table(converted, colWidths=[0.7 * inch, 3.0 * inch, 0.8 * inch], repeatRows=1)
    result.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_GRAY]),
                ("GRID", (0, 0), (-1, -1), 0.35, MID_GRAY),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    return result


def profiles_table(
    config: Mapping[str, Any],
    batch: Sequence[Mapping[str, str]],
    ranks: Sequence[int],
    style_map: Mapping[str, ParagraphStyle],
) -> Table:
    parameters = [parameter_rows(config, row) for row in batch]
    rows: list[list[Paragraph]] = [
        [
            Paragraph("Symbol", style_map["head"]),
            Paragraph("What the parameter represents", style_map["head"]),
            *[
                Paragraph(
                    f"Rank {rank}<br/>{escape(row['profile_id'])}",
                    style_map["head"],
                )
                for rank, row in zip(ranks, batch)
            ],
        ]
    ]
    section_rows: list[int] = []
    previous_section = None
    for index, (section, symbol, meaning, _value) in enumerate(parameters[0]):
        if section != previous_section:
            section_rows.append(len(rows))
            rows.append(
                [
                    Paragraph(escape(section), style_map["section"]),
                    Paragraph("", style_map["section"]),
                    *[Paragraph("", style_map["section"]) for _ in batch],
                ]
            )
            previous_section = section
        rows.append(
            [
                Paragraph(escape(symbol), style_map["cell_bold"]),
                Paragraph(escape(meaning), style_map["cell"]),
                *[
                    Paragraph(escape(profile_parameters[index][3]), style_map["cell"])
                    for profile_parameters in parameters
                ],
            ]
        )

    profile_width = 1.27 * inch if len(batch) <= 4 else 1.02 * inch
    result = Table(
        rows,
        colWidths=[0.67 * inch, 3.35 * inch] + [profile_width] * len(batch),
        repeatRows=1,
        hAlign="LEFT",
    )
    commands = [
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("GRID", (0, 0), (-1, -1), 0.25, MID_GRAY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 1.1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.1),
    ]
    data_row_index = 0
    for row_index in range(1, len(rows)):
        if row_index in section_rows:
            commands.extend(
                [
                    ("SPAN", (0, row_index), (-1, row_index)),
                    ("BACKGROUND", (0, row_index), (-1, row_index), LIGHT_BLUE),
                    ("TOPPADDING", (0, row_index), (-1, row_index), 1.8),
                    ("BOTTOMPADDING", (0, row_index), (-1, row_index), 1.8),
                ]
            )
        else:
            commands.append(
                (
                    "BACKGROUND",
                    (0, row_index),
                    (-1, row_index),
                    colors.white if data_row_index % 2 == 0 else LIGHT_GRAY,
                )
            )
            data_row_index += 1
    result.setStyle(TableStyle(commands))
    return result


def build_story(
    config: Mapping[str, Any], rows: Sequence[Mapping[str, str]], style_map: Mapping[str, ParagraphStyle]
) -> list[Any]:
    top_n = min(int(config["best_profiles_pdf_count"]), len(rows))
    selected = rows[:top_n]
    story: list[Any] = [
        Spacer(1, 0.05 * inch),
        Paragraph("Best parameter profiles", style_map["title"]),
        Paragraph(
            "Profiles are shown in the same review order as parameter_profiles.csv. A profile marked Pass satisfies every current screen; a failed profile is included only when too few profiles pass. The table lists the variable symbol, its plain-language meaning, and its value in each profile.",
            style_map["subtitle"],
        ),
        Paragraph(
            "<b>Fixed inputs:</b> "
            f"R = {config['rounds']} total rounds; "
            f"R_M = {config['movie_rounds']} Movie rounds; "
            f"Q = {config['main_target']} Main choices; "
            f"S = {int(config['rounds']) - int(config['movie_rounds']) - int(config['main_target'])} side choices when both threshold tasks are completed; "
            f"K = {config['side_cards_per_round']} distinct side cards per round.",
            style_map["subtitle"],
        ),
        Spacer(1, 0.04 * inch),
    ]
    batch_size = 4
    for start in range(0, top_n, batch_size):
        if start:
            story.append(PageBreak())
            story.append(Paragraph("Best parameter profiles (continued)", style_map["title"]))
        batch = selected[start : start + batch_size]
        ranks = list(range(start + 1, start + 1 + len(batch)))
        story.append(profiles_table(config, batch, ranks, style_map))
    return story


def build_pdf(config_path: Path, results_dir: Path, output_path: Path) -> None:
    config, rows = load_rows(config_path, results_dir)
    style_map = styles()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    doc = BaseDocTemplate(
        str(output_path),
        pagesize=landscape(letter),
        leftMargin=0.42 * inch,
        rightMargin=0.42 * inch,
        topMargin=0.34 * inch,
        bottomMargin=0.48 * inch,
        title="Best Card Stacking parameter profiles",
        author="Mismanaging Minutes project",
        subject="Compact comparison of the highest-ranked calibration profiles",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="body")
    doc.addPageTemplates(PageTemplate(id="main", frames=[frame], onPage=page_header_footer))
    doc.build(build_story(config, rows, style_map))


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
