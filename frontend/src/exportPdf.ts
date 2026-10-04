import { inkCanvas, type Stroke } from "./board/geometry";

/**
 * Download the page as a PDF: the problem as a heading, then the handwriting
 * on ruled lines, split across US Letter pages if it runs long. Built in the
 * browser, so it works without the server and with nothing filed yet.
 */
export async function exportBoardPdf(opts: { problem: string; strokes: Stroke[]; student?: string; course?: string }) {
  const canvas = inkCanvas(opts.strokes, 2);
  if (!canvas) return;
  // Loaded on demand so the main bundle stays light.
  const { jsPDF } = await import("jspdf");

  const page = { w: 612, h: 792, margin: 54 };
  const textW = page.w - page.margin * 2;
  const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });

  // Heading: the problem, then who and when.
  let y = page.margin;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  const title = doc.splitTextToSize(pdfSafe(opts.problem || "Untitled problem"), textW) as string[];
  doc.text(title, page.margin, y + 12);
  y += 12 + title.length * 19;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10.5);
  doc.setTextColor(110);
  const who = [opts.student, opts.course].filter(Boolean).join(" · ");
  const when = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  doc.text(who ? `${who} · ${when}` : when, page.margin, y + 4);
  y += 18;
  doc.setDrawColor(30);
  doc.setLineWidth(1);
  doc.line(page.margin, y, page.w - page.margin, y);
  y += 16;
  doc.setTextColor(0);

  // The ink, scaled to the text width and sliced into page-sized bands.
  const scale = textW / canvas.width;
  const inkH = canvas.height * scale;
  let srcY = 0;
  let firstBand = true;
  while (srcY < canvas.height) {
    const roomPt = page.h - page.margin - y;
    if (roomPt < 60 && !firstBand) {
      doc.addPage();
      y = page.margin;
      continue;
    }
    const bandPx = Math.min(canvas.height - srcY, Math.floor(roomPt / scale));
    if (bandPx <= 0) {
      doc.addPage();
      y = page.margin;
      continue;
    }
    const band = document.createElement("canvas");
    band.width = canvas.width;
    band.height = bandPx;
    band.getContext("2d")!.drawImage(canvas, 0, srcY, canvas.width, bandPx, 0, 0, canvas.width, bandPx);
    doc.addImage(band.toDataURL("image/png"), "PNG", page.margin, y, textW, bandPx * scale);
    y += bandPx * scale;
    srcY += bandPx;
    firstBand = false;
    if (srcY < canvas.height) {
      doc.addPage();
      y = page.margin;
    }
  }
  void inkH;

  // Footer on every page.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(9);
    doc.setTextColor(150);
    doc.text(`Worked on Untangled · page ${p} of ${pages}`, page.margin, page.h - 28);
  }

  doc.save(`${fileName(opts.problem)}.pdf`);
}

/** jsPDF's built-in fonts cover Latin-1 only: swap the math glyphs it can't draw. */
function pdfSafe(s: string): string {
  return s
    .replace(/−|–|—/g, "-")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/≠/g, "!=")
    .replace(/√/g, "sqrt")
    .replace(/π/g, "pi")
    .replace(/∞/g, "infinity")
    .replace(/[^\x20-\xff]/g, "?");
}

function fileName(problem: string): string {
  const slug = problem.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return slug || "untangled-page";
}
