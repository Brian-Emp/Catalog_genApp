// Implementation of the "extract" subcommand.
//
// Strategy:
// 1. Init PDFium, open the source PDF.
// 2. For each page:
//    a. Retrieve page_size (width, height).
//    b. Iterate the PDFium page objects:
//       - TEXT objects -> text_span (heuristic typing: section_banner
//         if large text at the top, page_number if small digit at the foot,
//         running_header otherwise).
//       - IMAGE objects -> decoration slot kind=image.
//       - PATH (vector) objects -> decoration slot kind=vector.
//    c. Write page-NNN.json into outDir.
//
// bbox convention: we convert PDFium coords (bottom-left origin,
// Y increasing upward) to the schema convention (top-left origin).

#include "extract.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "fpdfview.h"
#include "fpdf_text.h"
#include "fpdf_edit.h"

#include "pdfium_init.hpp"
#include "../vendor/json.hpp"

namespace catgen {

using json = nlohmann::ordered_json;
namespace fs = std::filesystem;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Converts (left, bottom, right, top) in PDFium coords (bottom-left origin)
// to [x0, y0, x1, y1] in schema coords (top-left origin).
static json toBbox(float left, float bottom, float right, float top, float pageHeight) {
  return json::array({
    left,
    pageHeight - top,
    right,
    pageHeight - bottom,
  });
}

// Formats an RGB color (0-255) as lowercase "#rrggbb".
static std::string toHexColor(unsigned r, unsigned g, unsigned b) {
  char buf[8];
  std::snprintf(buf, sizeof(buf), "#%02x%02x%02x", r & 0xFF, g & 0xFF, b & 0xFF);
  return std::string(buf);
}

// Converts a UTF-16LE buffer (PDFium output) into a UTF-8 std::string.
// Ignores BOMs and trailing null characters.
static std::string utf16LeToUtf8(const unsigned short* data, int charCount) {
  std::string out;
  out.reserve(charCount);
  for (int i = 0; i < charCount; ++i) {
    unsigned short u = data[i];
    if (u == 0) continue;
    if (u < 0x80) {
      out.push_back(static_cast<char>(u));
    } else if (u < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (u >> 6)));
      out.push_back(static_cast<char>(0x80 | (u & 0x3F)));
    } else {
      // No surrogate pair handling here (basic ASCII/Latin-1/BMP is enough
      // for a product catalog). To be extended if needed.
      out.push_back(static_cast<char>(0xE0 | (u >> 12)));
      out.push_back(static_cast<char>(0x80 | ((u >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (u & 0x3F)));
    }
  }
  return out;
}

// Simple heuristic: detects whether a text looks like a page number
// (1-3 digits optionally preceded/followed by "/", "p.", etc.).
static bool looksLikePageNumber(const std::string& s) {
  std::string trimmed;
  for (char c : s) {
    if (!std::isspace(static_cast<unsigned char>(c))) trimmed.push_back(c);
  }
  if (trimmed.empty() || trimmed.size() > 6) return false;
  int digits = 0;
  for (char c : trimmed) {
    if (std::isdigit(static_cast<unsigned char>(c))) ++digits;
    else if (c != '/' && c != '-' && c != '.' && c != 'p' && c != 'P') return false;
  }
  return digits >= 1 && digits <= 4;
}

// Heuristic: "..." or "....." within a text = TOC leader.
static bool hasDotLeader(const std::string& s) {
  return s.find("...") != std::string::npos
      || s.find(". . .") != std::string::npos;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction of a text object → typed JSON slot
// ─────────────────────────────────────────────────────────────────────────────

struct ExtractedText {
  std::string text;
  float left;
  float bottom;
  float right;
  float top;
  float fontSize;
  std::string fontName;
  std::string colorHex;
};

static bool extractTextObject(FPDF_PAGEOBJECT obj, FPDF_TEXTPAGE textPage,
                               ExtractedText& out) {
  // UTF-16 text: 1st call to measure (in bytes, terminator included),
  // then 2nd call with the allocated buffer. textPage may be null if the
  // page could not be indexed: we skip cleanly.
  if (!textPage) return false;
  unsigned long neededBytes = FPDFTextObj_GetText(obj, textPage, nullptr, 0);
  if (neededBytes <= 2) return false;  // just the null terminator
  std::vector<unsigned short> buf(neededBytes / 2);
  FPDFTextObj_GetText(obj, textPage, buf.data(), neededBytes);
  out.text = utf16LeToUtf8(buf.data(), static_cast<int>(buf.size()));
  if (out.text.empty()) return false;

  // Bbox
  if (!FPDFPageObj_GetBounds(obj, &out.left, &out.bottom, &out.right, &out.top)) {
    return false;
  }

  // Font size
  if (!FPDFTextObj_GetFontSize(obj, &out.fontSize)) {
    out.fontSize = 0;
  }
  // PDFium returns the RAW font_size (often 1.0 on InDesign PDFs that
  // apply the scale via the matrix). The actual rendered size = font_size
  // * |scale| of the matrix. We apply the factor here to get a size
  // usable by the heuristics (section_banner if size >= 14, etc.).
  FS_MATRIX mat;
  if (FPDFPageObj_GetMatrix(obj, &mat)) {
    float scaleX = std::sqrt(mat.a * mat.a + mat.b * mat.b);
    if (scaleX > 0) out.fontSize *= scaleX;
  }

  // Font name: retrieved via the FPDF_FONT
  FPDF_FONT font = FPDFTextObj_GetFont(obj);
  if (font) {
    char fontBuf[256] = {0};
    unsigned long flen = FPDFFont_GetBaseFontName(font, fontBuf, sizeof(fontBuf));
    if (flen > 0 && flen <= sizeof(fontBuf)) {
      out.fontName.assign(fontBuf, flen - 1);  // -1 to exclude the trailing \0
      // Strip the "AAAAAA+" prefix if subset (6 letters + +)
      auto plus = out.fontName.find('+');
      if (plus == 6) out.fontName = out.fontName.substr(7);
    }
  }
  if (out.fontName.empty()) out.fontName = "Unknown";

  // Fill color
  unsigned int r = 0, g = 0, b = 0, a = 0;
  if (FPDFPageObj_GetFillColor(obj, &r, &g, &b, &a)) {
    out.colorHex = toHexColor(r, g, b);
  } else {
    out.colorHex = "#000000";
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slot typing heuristics
// ─────────────────────────────────────────────────────────────────────────────

// Decides the slot type for a given text, based on its position and
// its size. Returns one of the schema's SLOT_TYPES strings.
static std::string classifyTextSlot(const ExtractedText& t, float pageW, float pageH) {
  // Schema coords (top-left)
  float y0 = pageH - t.top;
  float y1 = pageH - t.bottom;

  // Section banner: two independent criteria.
  //
  // Criterion A — large text in the upper quarter of the page (the
  // original criterion broadened: 14pt + y<50 -> 11pt + y < 25% of page height).
  // Covers banners at the top of a section page.
  //
  // Criterion B — wide text (> 55% of the page width) with size >= 9pt
  // up to 60% of the page height. Covers centered horizontal banners
  // (overlaid on a colored background in InDesign) and range titles
  // that span the page.
  //
  // We exclude texts that are too short (< 2 chars after trim) so as not to
  // classify page numbers or decorative bullets.
  {
    std::string trimmed = t.text;
    size_t s = 0, e = trimmed.size();
    while (s < e && (trimmed[s] == ' ' || trimmed[s] == '\t')) ++s;
    while (e > s && (trimmed[e-1] == ' ' || trimmed[e-1] == '\t')) --e;
    size_t trimLen = e - s;

    float textWidth = t.right - t.left;
    float relY = (pageH > 0) ? y0 / pageH : 0.0f;
    bool isWide   = (pageW > 0) && textWidth > pageW * 0.55f;
    bool isTop    = relY < 0.25f;
    bool isBig    = t.fontSize >= 11.0f;
    bool isMedium = t.fontSize >= 9.0f;
    // Min 6 chars: excludes "Inox", "Noir", "Gris", "Mat" which are
    // colors frequently written at the top of product sheets. Legitimate
    // ER sections: "AÉRATEURS"=10, "BIDETS"=6, "BONDES"=6, etc.
    bool notTooShort = trimLen >= 6;

    if (notTooShort && ((isBig && isTop) || (isWide && isMedium && relY < 0.60f))) {
      return "section_banner";
    }
  }

  // Page number: very low + short text resembling a number
  if (y1 > pageH - 40.0f && looksLikePageNumber(t.text)) {
    return "page_number";
  }

  // Toc entry: line containing dot leaders
  if (hasDotLeader(t.text)) {
    return "toc_entry";
  }

  // Toc title: very large text at the top of the page (but not at the edge)
  if (t.fontSize >= 24.0f && y0 < 200.0f) {
    return "toc_title";
  }

  // Default: classify as running_header (neutral catch-all, will be reclassified
  // by Claude at planning time or patched by hand by the user).
  return "running_header";
}

// Builds the JSON slot for a text.
static json buildTextSlot(const ExtractedText& t, float pageW, float pageH,
                          int& nextId) {
  std::string type = classifyTextSlot(t, pageW, pageH);
  json span = {
    {"text", t.text},
    {"bbox", toBbox(t.left, t.bottom, t.right, t.top, pageH)},
    {"font", t.fontName},
    {"size", t.fontSize},
    {"color", t.colorHex},
  };

  json slot = {
    {"type", type},
    {"id", type + "_" + std::to_string(nextId++)},
    {"bbox", toBbox(t.left, t.bottom, t.right, t.top, pageH)},
    {"label", span},
  };

  // Type-specific fields
  if (type == "page_number") {
    // Try to parse the number
    int num = 0;
    for (char c : t.text) {
      if (std::isdigit(static_cast<unsigned char>(c))) num = num * 10 + (c - '0');
    }
    if (num > 0) slot["current_number"] = num;
  } else if (type == "toc_entry") {
    // page_number_text: heuristic split. A typical toc entry is
    // "Section title .................. 42" or "Title  42". We extract
    // the trailing digits as page_number_text with an approximated bbox
    // (right segment of the original span). If there are no trailing digits, we
    // reuse the whole label (historical fallback).
    const std::string& text = t.text;
    int digitsStart = -1;
    for (int i = static_cast<int>(text.size()) - 1; i >= 0; --i) {
      unsigned char c = static_cast<unsigned char>(text[i]);
      if (std::isdigit(c)) {
        digitsStart = i;
      } else if (c == ' ' || c == '.' || c == '\t') {
        if (digitsStart >= 0) break;
      } else {
        break;
      }
    }
    if (digitsStart > 0 && digitsStart < static_cast<int>(text.size())) {
      std::string numText = text.substr(digitsStart);
      // Approximate bbox: last portion (proportional to the
      // length of the sub-text). Not exact but sufficient for
      // reuse on the substitutor side (which re-positions via insertAtSpan).
      float total = t.right - t.left;
      float fraction = static_cast<float>(numText.size()) / static_cast<float>(text.size());
      float numLeft = t.right - total * fraction;
      json numBbox = toBbox(numLeft, t.bottom, t.right, t.top, pageH);
      slot["page_number_text"] = json{
        {"text", numText},
        {"bbox", numBbox},
        {"font", t.fontName},
        {"size", t.fontSize},
        {"color", t.colorHex},
      };
    } else {
      slot["page_number_text"] = span;
    }
  }

  return slot;
}

// Decoration slot for an image or a vector path.
static json buildDecorationSlot(FPDF_PAGEOBJECT obj, const std::string& kind,
                                 float pageH, int& nextId) {
  float left = 0, bottom = 0, right = 0, top = 0;
  if (!FPDFPageObj_GetBounds(obj, &left, &bottom, &right, &top)) {
    return nullptr;
  }
  json bbox = toBbox(left, bottom, right, top, pageH);
  return json{
    {"type", "decoration"},
    {"id", "decoration_" + std::to_string(nextId++)},
    {"bbox", bbox},
    {"kind", kind},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction of a complete page
// ─────────────────────────────────────────────────────────────────────────────

static json extractPage(FPDF_DOCUMENT doc, int pageIndex) {
  FPDF_PAGE page = FPDF_LoadPage(doc, pageIndex);
  if (!page) {
    std::cerr << "Impossible de charger page " << pageIndex << "\n";
    return nullptr;
  }
  float pageW = FPDF_GetPageWidthF(page);
  float pageH = FPDF_GetPageHeightF(page);

  // text_page: handle required for FPDFTextObj_GetText. Loaded ONCE
  // for the page, closed after the loop. May return nullptr on an encrypted
  // PDF / corrupted form: text pages are then simply skipped.
  FPDF_TEXTPAGE textPage = FPDFText_LoadPage(page);
  if (!textPage) {
    std::cerr << "Page " << pageIndex << " : FPDFText_LoadPage a echoue, texte non extrait\n";
  }

  json slots = json::array();
  // raw_spans: ALL the text spans of the page without type inference. Used
  // by the V2 (TS) pipeline that carries find_product_blocks/auto_detect_template
  // over from the V1 Python engine. The slots field remains for backward compat.
  json rawSpans = json::array();
  // raw_images: bbox of all bitmap images. Used to detect the
  // color variants (square thumbnails) and the product's main image.
  json rawImages = json::array();
  // raw_paths: bbox + fillColor of the colored paths (non white/transparent).
  // Used to recover the background color of a section_banner cartouche so it
  // can be substituted while preserving the template tint.
  json rawPaths = json::array();
  int nextId = 0;

  // P5 (V2.1 audit): recursive descent into the FORM XObjects (groups
  // of reusable objects common in InDesign PDFs). Without this,
  // some product content is invisible in the page-NN.json.
  std::function<void(FPDF_PAGEOBJECT)> processObject = [&](FPDF_PAGEOBJECT obj) {
    if (!obj) return;
    int type = FPDFPageObj_GetType(obj);
    if (type == FPDF_PAGEOBJ_TEXT) {
      ExtractedText t;
      if (extractTextObject(obj, textPage, t)) {
        bool allSpace = true;
        for (char c : t.text) if (!std::isspace(static_cast<unsigned char>(c))) { allSpace = false; break; }
        if (!allSpace) {
          slots.push_back(buildTextSlot(t, pageW, pageH, nextId));
          rawSpans.push_back({
            {"text", t.text},
            {"bbox", toBbox(t.left, t.bottom, t.right, t.top, pageH)},
            {"font", t.fontName},
            {"size", t.fontSize},
            {"color", t.colorHex},
          });
        }
      }
    } else if (type == FPDF_PAGEOBJ_IMAGE) {
      json slot = buildDecorationSlot(obj, "image", pageH, nextId);
      if (!slot.is_null()) {
        slots.push_back(slot);
        rawImages.push_back(slot["bbox"]);
      }
    } else if (type == FPDF_PAGEOBJ_PATH) {
      // Also capture the fillColor if the path is filled, non white, non
      // transparent. Used by substituteSectionBanners to match the
      // colored background of a cartouche.
      float pl=0, pb=0, pr=0, pt=0;
      if (FPDFPageObj_GetBounds(obj, &pl, &pb, &pr, &pt)) {
        unsigned int R=0, G=0, B=0, A=0;
        if (FPDFPageObj_GetFillColor(obj, &R, &G, &B, &A) && A > 0) {
          if (!(R >= 250 && G >= 250 && B >= 250)) {
            rawPaths.push_back({
              {"bbox", toBbox(pl, pb, pr, pt, pageH)},
              {"fill_color", toHexColor(R, G, B)},
            });
          }
        }
      }
      json slot = buildDecorationSlot(obj, "vector", pageH, nextId);
      if (!slot.is_null()) slots.push_back(slot);
    } else if (type == FPDF_PAGEOBJ_FORM) {
      int subN = FPDFFormObj_CountObjects(obj);
      for (int j = 0; j < subN; ++j) {
        processObject(FPDFFormObj_GetObject(obj, j));
      }
    }
  };

  int n = FPDFPage_CountObjects(page);
  for (int i = 0; i < n; ++i) {
    processObject(FPDFPage_GetObject(page, i));
  }

  json result = {
    {"page_number", pageIndex},
    {"page_size", { {"width", pageW}, {"height", pageH} }},
    {"slots", slots},
    {"raw_spans", rawSpans},
    {"raw_images", rawImages},
    {"raw_paths", rawPaths},
    {"extractor_version", "0.3.0"},
  };

  if (textPage) FPDFText_ClosePage(textPage);
  FPDF_ClosePage(page);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

int runExtract(const std::string& inPdf, const std::string& outDir) {
  initPdfium();

  // Open the PDF
  FPDF_DOCUMENT doc = FPDF_LoadDocument(inPdf.c_str(), nullptr);
  if (!doc) {
    std::cerr << "Impossible d'ouvrir le PDF: " << inPdf
              << " (erreur PDFium: " << FPDF_GetLastError() << ")\n";
    destroyPdfium();
    return 3;
  }

  // Create the output directory
  std::error_code ec;
  fs::create_directories(outDir, ec);
  if (ec) {
    std::cerr << "Impossible de creer le dossier de sortie: " << outDir
              << " (" << ec.message() << ")\n";
    FPDF_CloseDocument(doc);
    destroyPdfium();
    return 4;
  }

  int pageCount = FPDF_GetPageCount(doc);
  std::cout << "Pages: " << pageCount << "\n";
  if (pageCount <= 0) {
    std::cerr << "PDF vide ou illisible (pageCount=" << pageCount << ") : "
              << inPdf << "\n";
    FPDF_CloseDocument(doc);
    destroyPdfium();
    return 5;
  }

  for (int i = 0; i < pageCount; ++i) {
    json page = extractPage(doc, i);
    if (page.is_null()) continue;

    // File name format: page-001.json (3 digits min)
    char nameBuf[32];
    std::snprintf(nameBuf, sizeof(nameBuf), "page-%03d.json", i);
    fs::path outPath = fs::path(outDir) / nameBuf;

    std::ofstream out(outPath);
    if (!out) {
      std::cerr << "Impossible d'ecrire " << outPath << "\n";
      continue;
    }
    out << page.dump(2) << "\n";
  }

  FPDF_CloseDocument(doc);
  destroyPdfium();
  std::cout << "Extraction OK: " << pageCount << " fichier(s) ecrit(s) dans "
            << outDir << "\n";
  return 0;
}

}  // namespace catgen
