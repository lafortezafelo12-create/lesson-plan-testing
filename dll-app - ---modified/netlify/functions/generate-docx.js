// netlify/functions/generate-docx.js
// Builds a .docx in the DLL | ILAW Format, with one column per day.

const {
  Document,
  Packer,
  Table,
  TableRow,
  TableCell,
  Paragraph,
  TextRun,
  WidthType,
  ShadingType,
  BorderStyle,
  AlignmentType,
  HeadingLevel,
  VerticalAlign,
  PageOrientation,
} = require("docx");

const NAVY = "1F3864";
const LIGHT_BLUE = "DCE6F1";
const WHITE = "FFFFFF";

const PAGE_MARGIN = 720; // 0.5in
const LABEL_W = 2400;

function usableWidth() {
  // A4 landscape width (16838) minus left/right margins
  return 16838 - PAGE_MARGIN * 2;
}

function dayColWidth(numDays) {
  return Math.floor((usableWidth() - LABEL_W) / numDays);
}

function cellBorders() {
  const b = { style: BorderStyle.SINGLE, size: 4, color: "444444" };
  return { top: b, bottom: b, left: b, right: b };
}

function parseInlineRuns(lineText, { size, color, italic, baseBold }) {
  // Splits on **bold** markers and returns an array of TextRun.
  const parts = lineText.split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== "");
  if (!parts.length) return [new TextRun({ text: "", size, color, italics: italic })];
  return parts.map((part) => {
    const isBold = /^\*\*[^*]+\*\*$/.test(part);
    const clean = isBold ? part.slice(2, -2) : part;
    return new TextRun({ text: clean, bold: baseBold || isBold, italics: italic, size, color });
  });
}

function renderRichLines(text, { size = 20, color = "000000", italic = false, bold = false, align } = {}) {
  const rawLines = (text || "").toString().split("\n").filter((l) => l.trim().length > 0);
  if (!rawLines.length) return [new Paragraph({ children: [new TextRun({ text: "", size })], alignment: align })];

  return rawLines.map((raw) => {
    const isBullet = /^[-•]\s+/.test(raw);
    const content = raw.replace(/^[-•]\s+/, "");
    const runs = parseInlineRuns(content, { size, color, italic, baseBold: bold });
    if (isBullet) {
      return new Paragraph({
        children: [new TextRun({ text: "•  ", size, color }), ...runs],
        indent: { left: 200, hanging: 200 },
        spacing: { after: 40 },
        alignment: align,
      });
    }
    return new Paragraph({ children: runs, spacing: { after: 40, before: 60 }, alignment: align });
  });
}

function textCell(text, { width, bold = false, italic = false, shade, color, align, size = 20, valign } = {}) {
  const paras = renderRichLines(text, { size, color: color || "000000", italic, bold, align });
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: cellBorders(),
    shading: shade ? { type: ShadingType.CLEAR, fill: shade } : undefined,
    verticalAlign: valign || VerticalAlign.TOP,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    children: paras,
  });
}

function labelCell(title, desc, width) {
  const children = [
    new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 20 })] }),
  ];
  if (desc) {
    children.push(
      new Paragraph({ children: [new TextRun({ text: desc, italics: true, size: 16 })] })
    );
  }
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: cellBorders(),
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    children,
  });
}

function sectionHeaderRow(title, desc, totalCols, totalWidth) {
  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: title, bold: true, color: WHITE, size: 22 })],
    }),
  ];
  if (desc) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [new TextRun({ text: desc, italics: true, color: WHITE, size: 16 })],
      })
    );
  }
  return new TableRow({
    children: [
      new TableCell({
        columnSpan: totalCols,
        width: { size: totalWidth, type: WidthType.DXA },
        borders: cellBorders(),
        shading: { type: ShadingType.CLEAR, fill: NAVY },
        margins: { top: 100, bottom: 100, left: 120, right: 120 },
        children,
      }),
    ],
  });
}

function dayHeaderRow(numDays, colWidth) {
  const cells = [labelCell("Learning Session", "", LABEL_W)];
  for (let d = 1; d <= numDays; d++) {
    cells.push(
      textCell(`Day ${d}`, {
        width: colWidth,
        bold: true,
        shade: LIGHT_BLUE,
        align: AlignmentType.CENTER,
        size: 22,
      })
    );
  }
  return new TableRow({ children: cells });
}

function contentRow(label, desc, values, colWidth) {
  const cells = [labelCell(label, desc, LABEL_W)];
  values.forEach((v) => cells.push(textCell(v, { width: colWidth })));
  return new TableRow({ children: cells });
}

function mergedRow(label, desc, value, numDays, colWidth) {
  const spanWidth = colWidth * numDays;
  return new TableRow({
    children: [
      labelCell(label, desc, LABEL_W),
      new TableCell({
        columnSpan: numDays,
        width: { size: spanWidth, type: WidthType.DXA },
        borders: cellBorders(),
        margins: { top: 80, bottom: 80, left: 100, right: 100 },
        children: renderRichLines(value, { size: 20 }),
      }),
    ],
  });
}

function headerInfoTable(meta) {
  // Shared 4-column grid: label | value | label2 | value2.
  // Rows that only need one value span columns 1-3 (columnSpan: 3) so the
  // grid stays consistent across every row (docx-js "dual widths" gotcha).
  const w = usableWidth();
  const c1 = Math.floor(w * 0.22);
  const c2 = Math.floor(w * 0.28);
  const c3 = Math.floor(w * 0.22);
  const c4 = w - c1 - c2 - c3;
  const wideWidth = c2 + c3 + c4;

  const wideCell = (label, desc, value, bold = false) =>
    new TableRow({
      children: [
        labelCell(label, desc, c1),
        new TableCell({
          columnSpan: 3,
          width: { size: wideWidth, type: WidthType.DXA },
          borders: cellBorders(),
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
          children: renderRichLines(value, { size: 20, bold }),
        }),
      ],
    });

  const splitRow = (labelA, valA, labelB, valB) =>
    new TableRow({
      children: [
        labelCell(labelA, "", c1),
        textCell(valA, { width: c2 }),
        labelCell(labelB, "", c3),
        textCell(valB, { width: c4 }),
      ],
    });

  return new Table({
    width: { size: w, type: WidthType.DXA },
    columnWidths: [c1, c2, c3, c4],
    rows: [
      wideCell("Lesson Title", "", meta.lessonTitle, true),
      splitRow("Learning Area", meta.subject, "Term and Week", meta.termWeek),
      wideCell("Name of Teacher", "", meta.teacherName),
      splitRow("Grade Level and Section", meta.gradeSection, "Date and Time", meta.dateTime),
      wideCell("No. of Sessions", "", String(meta.numDays)),
      wideCell("References", "(books, websites, toolkits, etc.)", meta.references),
      wideCell(
        "Declaration of AI Use",
        "Cite how AI was used in the formulation of the lesson plan.",
        meta.aiDeclaration
      ),
    ],
  });
}

function buildMainTable(days, competency) {
  const numDays = days.length;
  const colW = dayColWidth(numDays);
  const totalCols = numDays + 1;
  const totalWidth = LABEL_W + colW * numDays;

  const rows = [];

  rows.push(
    sectionHeaderRow(
      "Intensions",
      "Meaningful learning experiences are anchored in how we frame them.",
      totalCols,
      totalWidth
    )
  );
  rows.push(dayHeaderRow(numDays, colW));
  rows.push(
    mergedRow(
      "Learning Competency and Curriculum Standards",
      "Competency/ies and content/performance standards for the sessions.",
      competency,
      numDays,
      colW
    )
  );
  rows.push(
    contentRow(
      "Learning Objectives",
      "",
      days.map((d) => d.objectives),
      colW
    )
  );
  rows.push(
    contentRow(
      "Learner Context",
      "",
      days.map((d) => d.learnerContext),
      colW
    )
  );

  rows.push(
    sectionHeaderRow(
      "Learning Experience",
      "Each activity builds towards meaningful understanding and growth.",
      totalCols,
      totalWidth
    )
  );
  rows.push(contentRow("Pre-Lesson", "", days.map((d) => d.preLesson), colW));
  rows.push(contentRow("Flow", "", days.map((d) => d.flow), colW));
  rows.push(contentRow("Learning Resources", "", days.map((d) => d.resources), colW));
  rows.push(contentRow("Opportunities for Integration", "", days.map((d) => d.integration), colW));

  rows.push(
    sectionHeaderRow(
      "Assessment",
      "Reveals what learners have gained and what they still need help with.",
      totalCols,
      totalWidth
    )
  );
  rows.push(contentRow("Formative Assessment", "", days.map((d) => d.assessment), colW));

  rows.push(
    sectionHeaderRow(
      "Ways Forward",
      "Meaningful learning can also happen beyond the classroom.",
      totalCols,
      totalWidth
    )
  );
  rows.push(contentRow("Extended Learning Opportunities", "", days.map((d) => d.extended), colW));
  rows.push(
    contentRow(
      "Reflections",
      "",
      days.map(() => "(To be completed by the teacher after delivering the session.)"),
      colW
    )
  );

  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths: [LABEL_W, ...Array(numDays).fill(colW)],
    rows,
  });
}

function signatureTable() {
  const w = usableWidth();
  const colW = Math.floor(w / 4);
  const mkCell = (role, name, position) =>
    new TableCell({
      width: { size: colW, type: WidthType.DXA },
      borders: {
        top: { style: BorderStyle.NONE },
        bottom: { style: BorderStyle.NONE },
        left: { style: BorderStyle.NONE },
        right: { style: BorderStyle.NONE },
      },
      children: [
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: role, size: 18 })] }),
        new Paragraph({ spacing: { before: 200 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: name, bold: true, size: 20 })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: position, size: 16 })] }),
      ],
    });

  return new Table({
    width: { size: w, type: WidthType.DXA },
    columnWidths: [colW, colW, colW, colW],
    rows: [
      new TableRow({
        children: [
          mkCell("Prepared by:", "[Teacher's Name]", "Teacher"),
          mkCell("Checked by:", "[Master Teacher's Name]", "Master Teacher"),
          mkCell("Verified by:", "[Head Teacher's Name]", "Head Teacher"),
          mkCell("Noted by:", "[Principal's Name]", "Principal"),
        ],
      }),
    ],
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { meta, competency, days } = body;
  if (!meta || !competency || !Array.isArray(days) || days.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "meta, competency, and days[] are required" }) };
  }

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE },
            margin: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
          },
        },
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: "DAILY LESSON LOGS | ILAW Format", bold: true, size: 28 })],
          }),
          new Paragraph({ text: "" }),
          headerInfoTable(meta),
          new Paragraph({ text: "" }),
          buildMainTable(days, competency),
          new Paragraph({ text: "" }),
          signatureTable(),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${(meta.lessonTitle || "DLL").replace(/[^a-z0-9]+/gi, "_")}.docx"`,
    },
    isBase64Encoded: true,
    body: buffer.toString("base64"),
  };
};
