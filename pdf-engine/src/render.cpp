// Implementation of the "render" subcommand.
//
// Strategy:
// 1. Load plan.json + all the extracted-page.json (templates/<name>/).
// 2. Open template.pdf (source).
// 3. Create a new destination document.
// 4. For each entry in plan.pages:
//    a. Import the source_page from the template into the destination document.
//    b. If render.mode == "operations": apply each op on the imported page.
// 5. Set the metadata (CreationDate, ModDate, Producer) for
//    bit-exact determinism.
// 6. Save the final PDF.
//
// bbox convention: the plan uses a top-left origin (same as the schema). PDFium
// uses a bottom-left origin. We convert at each op that places an object.

#include "render.hpp"

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "fpdfview.h"
#include "fpdf_edit.h"
#include "fpdf_save.h"
#include "fpdf_ppo.h"
#include "fpdf_doc.h"

#include "pdfium_init.hpp"
#include "../vendor/json.hpp"

// stb_image: decodes PNG/JPG/BMP/etc. into an RGBA bitmap. Single header,
// MIT, vendored under pdf-engine/vendor/. Single definition for linkage.
#define STB_IMAGE_IMPLEMENTATION
#define STB_IMAGE_STATIC
#include "../vendor/stb_image.h"

namespace catgen {

using json = nlohmann::ordered_json;
namespace fs = std::filesystem;

// ─────────────────────────────────────────────────────────────────────────────
// Cache of the extracted-page.json (indexed by source page_number)
// ─────────────────────────────────────────────────────────────────────────────
static std::map<int, json> g_extractedCache;

static void loadExtractedPages(const std::string& templatesDir) {
  g_extractedCache.clear();
  if (!fs::exists(templatesDir)) return;
  for (const auto& entry : fs::recursive_directory_iterator(templatesDir)) {
    if (!entry.is_regular_file()) continue;
    auto p = entry.path();
    if (p.extension() != ".json") continue;
    std::ifstream f(p);
    if (!f) continue;
    try {
      json j;
      f >> j;
      if (j.contains("page_number")) {
        int pn = j["page_number"].get<int>();
        g_extractedCache[pn] = std::move(j);
      }
    } catch (const std::exception& e) {
      std::cerr << "Skip JSON invalide " << p << " : " << e.what() << "\n";
    }
  }
}

// Finds a slot by id in the extracted-page of a source page. nullptr if absent.
static const json* findSlot(int sourcePage, const std::string& slotId) {
  auto it = g_extractedCache.find(sourcePage);
  if (it == g_extractedCache.end()) return nullptr;
  if (!it->second.contains("slots")) return nullptr;
  for (const auto& s : it->second["slots"]) {
    if (s.contains("id") && s["id"].get<std::string>() == slotId) return &s;
  }
  return nullptr;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDFium helpers
// ─────────────────────────────────────────────────────────────────────────────

// Converts a "#rrggbb" color into 0-255 components.
static bool parseHexColor(const std::string& hex, unsigned& r, unsigned& g, unsigned& b) {
  if (hex.size() != 7 || hex[0] != '#') return false;
  auto hx = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return 10 + c - 'a';
    if (c >= 'A' && c <= 'F') return 10 + c - 'A';
    return -1;
  };
  int rh = hx(hex[1]) * 16 + hx(hex[2]);
  int gh = hx(hex[3]) * 16 + hx(hex[4]);
  int bh = hx(hex[5]) * 16 + hx(hex[6]);
  if (rh < 0 || gh < 0 || bh < 0) return false;
  r = rh; g = gh; b = bh;
  return true;
}

// Converts UTF-8 → UTF-16LE buffer terminated by 0. ASCII/Latin-1/BMP.
static std::vector<unsigned short> utf8ToUtf16Le(const std::string& s) {
  std::vector<unsigned short> out;
  out.reserve(s.size() + 1);
  for (size_t i = 0; i < s.size(); ) {
    unsigned char c = s[i];
    unsigned int cp = 0;
    if (c < 0x80) { cp = c; i += 1; }
    else if ((c & 0xE0) == 0xC0 && i + 1 < s.size()) {
      cp = ((c & 0x1F) << 6) | (s[i + 1] & 0x3F);
      i += 2;
    }
    else if ((c & 0xF0) == 0xE0 && i + 2 < s.size()) {
      cp = ((c & 0x0F) << 12) | ((s[i + 1] & 0x3F) << 6) | (s[i + 2] & 0x3F);
      i += 3;
    }
    else { i += 1; continue; }  // skip invalid
    if (cp < 0x10000) {
      out.push_back(static_cast<unsigned short>(cp));
    } else {
      cp -= 0x10000;
      out.push_back(static_cast<unsigned short>(0xD800 | (cp >> 10)));
      out.push_back(static_cast<unsigned short>(0xDC00 | (cp & 0x3FF)));
    }
  }
  out.push_back(0);
  return out;
}

// Paints an opaque colored rect on the page. Default = white (erases). If
// (r, g, b) specified = overlays with that tint (section_banner case:
// orange of the template cartouche to preserve). PDFium coords (bottom-left
// origin).
static void paintColoredRect(FPDF_DOCUMENT doc, FPDF_PAGE page,
                              float left, float bottom, float right, float top,
                              unsigned r, unsigned g, unsigned b) {
  (void)doc;
  float w = right - left;
  float h = top - bottom;
  if (w <= 0 || h <= 0) return;
  FPDF_PAGEOBJECT rect = FPDFPageObj_CreateNewRect(left, bottom, w, h);
  if (!rect) return;
  FPDFPageObj_SetFillColor(rect, r, g, b, 255);
  FPDFPath_SetDrawMode(rect, FPDF_FILLMODE_WINDING, 0);
  FPDFPage_InsertObject(page, rect);
}

static void paintWhiteRect(FPDF_DOCUMENT doc, FPDF_PAGE page,
                            float left, float bottom, float right, float top) {
  paintColoredRect(doc, page, left, bottom, right, top, 255, 255, 255);
}

// P4 audit: insertText uses the font name of the original slot when provided.
// If PDFium doesn't find the font (not embedded, unknown name), it falls back
// silently to an internal font. We still try the standard PDF builtin fonts
// (Helvetica, Times, Courier) if nothing else works.
static void insertText(FPDF_DOCUMENT doc, FPDF_PAGE page, const std::string& text,
                        float fontSize, unsigned r, unsigned g, unsigned b,
                        float x, float y, const std::string& fontName = "",
                        int rotationDeg = 0) {
  if (text.empty() || fontSize <= 0) return;
  const char* fName = fontName.empty() ? "Helvetica" : fontName.c_str();
  FPDF_PAGEOBJECT obj = FPDFPageObj_NewTextObj(doc, fName, fontSize);
  if (!obj) {
    obj = FPDFPageObj_NewTextObj(doc, "Helvetica", fontSize);
    if (!obj) return;
  }
  auto u16 = utf8ToUtf16Le(text);
  FPDFText_SetText(obj, u16.data());
  FPDFPageObj_SetFillColor(obj, r, g, b, 255);
  // Affine matrix [a b c d e f] = rotation + translation.
  // rotation 90 CW  (vertical text bottom-to-top): (0, -1, 1, 0, x, y)
  // rotation 270 CW (vertical text top-to-bottom): (0, 1, -1, 0, x, y)
  if (rotationDeg == 90) {
    FPDFPageObj_Transform(obj, 0, -1, 1, 0, x, y);
  } else if (rotationDeg == 270) {
    FPDFPageObj_Transform(obj, 0, 1, -1, 0, x, y);
  } else {
    FPDFPageObj_Transform(obj, 1, 0, 0, 1, x, y);
  }
  FPDFPage_InsertObject(page, obj);
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation of the operations
// ─────────────────────────────────────────────────────────────────────────────

// Retrieves a slot's bbox, converting top-left -> bottom-left PDFium.
// Returns {left, bottom, right, top} if OK, false otherwise.
static bool slotBboxToPdfium(const json& slot, float pageH,
                              float& left, float& bottom, float& right, float& top) {
  // label.bbox is more precise than slot.bbox for positioning the text.
  json bbox;
  if (slot.contains("label") && slot["label"].contains("bbox")) {
    bbox = slot["label"]["bbox"];
  } else if (slot.contains("bbox")) {
    bbox = slot["bbox"];
  } else {
    return false;
  }
  if (!bbox.is_array() || bbox.size() != 4) return false;
  float x0 = bbox[0].get<float>();
  float y0 = bbox[1].get<float>();  // top-left
  float x1 = bbox[2].get<float>();
  float y1 = bbox[3].get<float>();
  left = x0;
  right = x1;
  // top-left → bottom-left: y_pdfium = pageH - y_topleft
  top = pageH - y0;
  bottom = pageH - y1;
  return true;
}

// ─── Separate erase / insert helpers for the 2-pass ────────────────────────

// Extracts style + coords of a slot for set_text. Returns false if absent.
static bool resolveSlotForText(int sourcePage, const std::string& slotId, float pageH,
                                float& left, float& bottom, float& right, float& top,
                                float& size, unsigned& r, unsigned& g, unsigned& b,
                                std::string& fontName) {
  const json* slot = findSlot(sourcePage, slotId);
  if (!slot) {
    std::cerr << "set_text: slot_id '" << slotId << "' introuvable sur page " << sourcePage << "\n";
    return false;
  }
  if (!slotBboxToPdfium(*slot, pageH, left, bottom, right, top)) return false;
  size = 11.0f; r = 0; g = 0; b = 0;
  if (slot->contains("label")) {
    const json& lbl = (*slot)["label"];
    if (lbl.contains("size")) size = lbl["size"].get<float>();
    if (lbl.contains("color")) parseHexColor(lbl["color"].get<std::string>(), r, g, b);
    if (lbl.contains("font")) fontName = lbl["font"].get<std::string>();
  }
  return true;
}

// Padding for eraseSlotZone (slot resolution by id). 50% absorbs the
// descenders/accents that PDFium doesn't include in the glyph bbox. More
// generous than ERASE_PAD_INSERT_RATIO (35%) because the slot zone may span
// several lines (banner, label).
static constexpr float ERASE_PAD_SLOT_RATIO = 0.5f;
static constexpr float ERASE_PAD_SLOT_MIN_PT = 6.0f;

// Erases a slot's zone.
static void eraseSlotZone(FPDF_DOCUMENT doc, FPDF_PAGE page,
                           float left, float bottom, float right, float top) {
  float h = top - bottom;
  float padY = std::max(h * ERASE_PAD_SLOT_RATIO, ERASE_PAD_SLOT_MIN_PT);
  paintWhiteRect(doc, page, left - 2.0f, bottom - padY, right + 2.0f, top + padY);
}

// ─── Complete operations (erase + insert, used outside the 2-pass) ──────────

static void applyOpSetText(FPDF_DOCUMENT doc, FPDF_PAGE page, const json& op,
                            int sourcePage) {
  if (!op.contains("slot_id") || !op.contains("text")) return;
  const std::string& slotId = op["slot_id"];
  const std::string& text   = op["text"];
  float pageH = FPDF_GetPageHeightF(page);
  float left, bottom, right, top, size;
  unsigned r, g, b;
  std::string fontName;
  if (!resolveSlotForText(sourcePage, slotId, pageH,
                          left, bottom, right, top, size, r, g, b, fontName)) return;
  eraseSlotZone(doc, page, left, bottom, right, top);
  insertText(doc, page, text, size, r, g, b, left, bottom, fontName);
}

/** Physically removes ALL paths (vector) AND images of the page whose
 *  bbox is entirely contained within op.bbox. Useful when a white rect
 *  isn't enough (path drawn on top because of a form xobject /
 *  an unexpected PDFium render order). */
static void applyOpRemovePathsInBbox(FPDF_PAGE page, const json& op) {
  if (!op.contains("bbox")) return;
  const json& bbox = op["bbox"];
  if (!bbox.is_array() || bbox.size() != 4) return;
  float pageH = FPDF_GetPageHeightF(page);
  float x0 = bbox[0].get<float>();
  float y0 = bbox[1].get<float>();
  float x1 = bbox[2].get<float>();
  float y1 = bbox[3].get<float>();
  // Convert top-left -> bottom-left PDFium
  float left = x0, right = x1;
  float bottom = pageH - y1, top = pageH - y0;

  // Collect first then remove (modifying while iterating is unsafe).
  // We ONLY remove small-sized objects (decorative lines,
  // micro-pictos) — area < 1500 pt^2 by default. Prevents removing
  // section cartouches, structural ribbons, header bands, etc.
  const float maxArea = op.value("max_area", 1500.0f);
  std::vector<FPDF_PAGEOBJECT> toRemove;
  int n = FPDFPage_CountObjects(page);
  for (int i = 0; i < n; ++i) {
    FPDF_PAGEOBJECT obj = FPDFPage_GetObject(page, i);
    if (!obj) continue;
    int type = FPDFPageObj_GetType(obj);
    // PATH only (not IMAGE): images are the section cartouches,
    // bitmap pictos, etc. We leave them — they are erased when needed
    // by the classic erase_rect (polishResidualBitmaps).
    if (type != FPDF_PAGEOBJ_PATH) continue;
    float ol, ob, or_, ot;
    if (!FPDFPageObj_GetBounds(obj, &ol, &ob, &or_, &ot)) continue;
    // Object bbox entirely inscribed within the erase bbox
    if (ol < left - 1 || or_ > right + 1 || ob < bottom - 1 || ot > top + 1) continue;
    // Size filter: we keep the large objects (= structural)
    float w = or_ - ol;
    float h = ot - ob;
    if (w * h > maxArea) continue;
    toRemove.push_back(obj);
  }
  for (auto obj : toRemove) {
    if (FPDFPage_RemoveObject(page, obj)) {
      FPDFPageObj_Destroy(obj);
    }
  }
}

/** Physically removes the TEXT objects of the page whose bbox is
 *  inscribed within the op's bbox. Used to erase a page number over
 *  a photo background without leaving a visible blotch (a white/colored erase_rect
 *  would be visible over the photo). Text equivalent of applyOpRemovePathsInBbox. */
static void applyOpRemoveTextInBbox(FPDF_PAGE page, const json& op) {
  if (!op.contains("bbox")) return;
  const json& bbox = op["bbox"];
  if (!bbox.is_array() || bbox.size() != 4) return;
  float pageH = FPDF_GetPageHeightF(page);
  float x0 = bbox[0].get<float>();
  float y0 = bbox[1].get<float>();
  float x1 = bbox[2].get<float>();
  float y1 = bbox[3].get<float>();
  float left = x0, right = x1;
  float bottom = pageH - y1, top = pageH - y0;

  std::vector<FPDF_PAGEOBJECT> toRemove;
  int n = FPDFPage_CountObjects(page);
  for (int i = 0; i < n; ++i) {
    FPDF_PAGEOBJECT obj = FPDFPage_GetObject(page, i);
    if (!obj) continue;
    if (FPDFPageObj_GetType(obj) != FPDF_PAGEOBJ_TEXT) continue;
    float ol, ob, or_, ot;
    if (!FPDFPageObj_GetBounds(obj, &ol, &ob, &or_, &ot)) continue;
    // Object entirely inscribed within the target bbox (with 1pt tolerance)
    if (ol < left - 1 || or_ > right + 1 || ob < bottom - 1 || ot > top + 1) continue;
    toRemove.push_back(obj);
  }
  for (auto obj : toRemove) {
    if (FPDFPage_RemoveObject(page, obj)) {
      FPDFPageObj_Destroy(obj);
    }
  }
}

// Samples the background color in a thin band JUST ABOVE the rect
// (left..right, in PDFium bottom-left coords) by rendering the current page.
// Used to erase a page number over a photo background with the local tint (no
// glaring white block). Returns false on failure (the caller then keeps white).
static bool sampleBgColor(FPDF_PAGE page, float left, float right, float top,
                          unsigned& outR, unsigned& outG, unsigned& outB) {
  float pageW = FPDF_GetPageWidthF(page);
  float pageH = FPDF_GetPageHeightF(page);
  if (pageW <= 1.0f || pageH <= 1.0f) return false;
  const float scale = 2.0f;
  int W = static_cast<int>(pageW * scale);
  int H = static_cast<int>(pageH * scale);
  if (W <= 0 || H <= 0) return false;
  FPDF_BITMAP bmp = FPDFBitmap_Create(W, H, 1);  // BGRA
  if (!bmp) return false;
  FPDFBitmap_FillRect(bmp, 0, 0, W, H, 0xFFFFFFFF);  // opaque white background
  FPDF_RenderPageBitmap(bmp, page, 0, 0, W, H, 0, 0);
  unsigned char* buf = static_cast<unsigned char*>(FPDFBitmap_GetBuffer(bmp));
  int stride = FPDFBitmap_GetStride(bmp);
  // pdfium y band in [top+1, top+6] = just above the number (= photo,
  // the neighboring running header is to the LEFT not above). device y (top-left
  // origin) = (pageH - pdfium_y) * scale.
  double sr = 0, sg = 0, sb = 0; long cnt = 0;
  for (float yy = top + 1.0f; yy <= top + 6.0f; yy += 1.0f) {
    int devY = static_cast<int>((pageH - yy) * scale);
    if (devY < 0 || devY >= H) continue;
    for (float xx = left; xx <= right; xx += 1.0f) {
      int devX = static_cast<int>(xx * scale);
      if (devX < 0 || devX >= W) continue;
      const unsigned char* px = buf + devY * stride + devX * 4;
      sb += px[0]; sg += px[1]; sr += px[2]; ++cnt;
    }
  }
  FPDFBitmap_Destroy(bmp);
  if (cnt == 0) return false;
  outR = static_cast<unsigned>(sr / cnt);
  outG = static_cast<unsigned>(sg / cnt);
  outB = static_cast<unsigned>(sb / cnt);
  return true;
}

static void applyOpEraseRect(FPDF_DOCUMENT doc, FPDF_PAGE page, const json& op) {
  if (!op.contains("bbox")) return;
  const json& bbox = op["bbox"];
  if (!bbox.is_array() || bbox.size() != 4) return;
  float pageH = FPDF_GetPageHeightF(page);
  float x0 = bbox[0].get<float>();
  float y0 = bbox[1].get<float>();
  float x1 = bbox[2].get<float>();
  float y1 = bbox[3].get<float>();
  unsigned r = 255, g = 255, b = 255;
  if (op.contains("color") && op["color"].is_string()) {
    parseHexColor(op["color"].get<std::string>(), r, g, b);
  }
  // sample_bg: erases with the local background tint (footer number over a light
  // photo) instead of white → no visible white block. White fallback if it fails.
  if (op.value("sample_bg", false)) {
    unsigned sr, sg, sb;
    if (sampleBgColor(page, x0, x1, pageH - y0, sr, sg, sb)) {
      r = sr; g = sg; b = sb;
    }
  }
  paintColoredRect(doc, page, x0, pageH - y1, x1, pageH - y0, r, g, b);
}

// V2 engine: standalone text insertion (without slot_id dependency).
// The caller provides bbox + font + size + color. The bbox is in schema coords
// (top-left origin). The erase of the zone is included in PASS 1 (cf. the main
// 2-pass). The text insertion happens in PASS 2 at the baseline (bbox[3]).
static void applyOpInsertTextErase(FPDF_DOCUMENT doc, FPDF_PAGE page, const json& op) {
  if (!op.contains("bbox")) return;
  // Skip if no_erase=true: the caller just wants to rewrite a glyph
  // without a white blotch (page renum over a photo background).
  if (op.value("no_erase", false)) return;
  const json& bbox = op["bbox"];
  if (!bbox.is_array() || bbox.size() != 4) return;
  float pageH = FPDF_GetPageHeightF(page);
  float x0 = bbox[0].get<float>();
  float y0 = bbox[1].get<float>();
  float x1 = bbox[2].get<float>();
  float y1 = bbox[3].get<float>();
  // Padding for applyOpInsertTextErase (white auto-erase around the bbox
  // of an insert_text). 35% ratio, tighter than ERASE_PAD_SLOT_RATIO (50%)
  // because the insert_text bbox provided by the caller is already computed
  // tight around the expected text (the caller has the precise geometry).
  // Min 8pt = slightly wider than the slot for the decorative lines
  // that run alongside the name (seen on ER: thin header/specs separator rule).
  static constexpr float ERASE_PAD_INSERT_RATIO = 0.35f;
  static constexpr float ERASE_PAD_INSERT_MIN_PT = 8.0f;
  float h = y1 - y0;
  float padY = std::max(h * ERASE_PAD_INSERT_RATIO, ERASE_PAD_INSERT_MIN_PT);
  paintWhiteRect(doc, page, x0 - 2.0f, pageH - y1 - padY, x1 + 2.0f, pageH - y0 + padY);
}

static void applyOpInsertTextInsert(FPDF_DOCUMENT doc, FPDF_PAGE page, const json& op) {
  if (!op.contains("bbox") || !op.contains("text") || !op.contains("size")) return;
  const json& bbox = op["bbox"];
  if (!bbox.is_array() || bbox.size() != 4) return;
  float pageH = FPDF_GetPageHeightF(page);
  float x0 = bbox[0].get<float>();
  float y1 = bbox[3].get<float>();
  float size = op["size"].get<float>();
  std::string fontName = op.value("font", std::string{});
  std::string color = op.value("color", std::string{"#000000"});
  unsigned r = 0, g = 0, b = 0;
  parseHexColor(color, r, g, b);
  std::string text = op["text"].get<std::string>();
  // baseline ~ bottom of the span - small offset. y_pdfium = pageH - y1 + kBaselineOffsetPt.
  // This value is shared: if you change it, also change INSERT_TEXT_BASELINE_OFFSET
  // in src/v2/insertText.ts (TS must compensate since it knows the render's formula).
  constexpr float kBaselineOffsetPt = 2.0f;
  int rotation = op.value("rotation", 0);
  if (rotation == 90 || rotation == 270) {
    // Vertical text: x0 = column, y position = base of the text in PDFium coords.
    // For rotation 90 (bottom-to-top as in the ribbons), the anchor point
    // is the bottom-left corner of the text in PDFium page coordinates (y=0 = bottom).
    float y0 = bbox[1].get<float>();
    float anchorY = pageH - (y0 + (bbox[3].get<float>() - y0));
    insertText(doc, page, text, size, r, g, b, x0 + kBaselineOffsetPt, anchorY, fontName, rotation);
  } else {
    float baseline = pageH - y1 + kBaselineOffsetPt;
    insertText(doc, page, text, size, r, g, b, x0, baseline, fontName);
  }
}

static void applyOpDrawCircle(FPDF_DOCUMENT doc, FPDF_PAGE page, const json& op) {
  (void)doc;
  if (!op.contains("center") || !op.contains("radius") || !op.contains("color")) return;
  const json& c = op["center"];
  if (!c.is_array() || c.size() != 2) return;
  float cx = c[0].get<float>();
  float cy_topleft = c[1].get<float>();
  float radius = op["radius"].get<float>();
  if (radius <= 0) return;
  unsigned r = 0, g = 0, b = 0;
  parseHexColor(op["color"].get<std::string>(), r, g, b);
  float pageH = FPDF_GetPageHeightF(page);
  float cy = pageH - cy_topleft;
  // Circle via 4 cubic Beziers (standard PDF). Cleaner than a 32-segment
  // polygon: invisible edges even zoomed 200%. Magic constant
  // 0.5522847498 = (4/3) * tan(pi/8) — curvature control so that a
  // Bezier quarter circle matches the real circle to within < 0.03%.
  const float K = radius * 0.5522847498f;
  FPDF_PAGEOBJECT path = FPDFPageObj_CreateNewPath(cx + radius, cy);
  if (!path) return;
  // Right -> Top
  FPDFPath_BezierTo(path, cx + radius, cy + K, cx + K, cy + radius, cx, cy + radius);
  // Top -> Left
  FPDFPath_BezierTo(path, cx - K, cy + radius, cx - radius, cy + K, cx - radius, cy);
  // Left -> Bottom
  FPDFPath_BezierTo(path, cx - radius, cy - K, cx - K, cy - radius, cx, cy - radius);
  // Bottom -> Right
  FPDFPath_BezierTo(path, cx + K, cy - radius, cx + radius, cy - K, cx + radius, cy);
  FPDFPath_Close(path);
  FPDFPageObj_SetFillColor(path, r, g, b, 255);
  FPDFPath_SetDrawMode(path, FPDF_FILLMODE_WINDING, 0);
  FPDFPage_InsertObject(page, path);
}

// Loads an image (JPG, PNG, BMP, etc.) into a FPDF_PAGEOBJECT via stb_image.
//
// We do NOT use FPDFImageObj_LoadJpegFile (fast native JPG path): its
// FILEACCESS requires a persistent buffer via m_Param. If we load several
// JPGs in a row, a shared thread_local buffer is overwritten by each call;
// the images loaded BEFORE lose their data when PDFium reads lazily at
// GenerateContent. The stb path decodes right away into a bitmap that we copy
// into a PDFium buffer owned by PDFium (independent of the subsequent
// loads).
// Pixel ceiling before decode: bounds the allocation (w*h*4 bytes) against an
// image bomb (e.g. PNG 64000x64000 = 16 GB RGBA). 64 MP (~256 MB RGBA) covers
// any legitimate product scan while blocking decompression bombs.
static constexpr long long kMaxImagePixels = 64LL * 1000 * 1000;

static bool loadImageIntoObj(FPDF_DOCUMENT doc, FPDF_PAGEOBJECT img, const fs::path& full) {
  // SECURITY: first read the dimensions WITHOUT decoding (stbi_info), to
  // refuse an over-ceiling image BEFORE stb_image allocates the buffer.
  // If stbi_info fails, we REFUSE (rather than letting stbi_load decode
  // blindly): this way the ceiling is a real guarantee, not a best-effort.
  int iw = 0, ih = 0, ic = 0;
  if (!stbi_info(full.string().c_str(), &iw, &ih, &ic)) {
    std::cerr << "draw_image: stbi_info echec (entete illisible), refus avant decode "
              << full << "\n";
    return false;
  }
  if (iw <= 0 || ih <= 0
      || static_cast<long long>(iw) * static_cast<long long>(ih) > kMaxImagePixels) {
    std::cerr << "draw_image: image refusee (dimensions " << iw << "x" << ih
              << " > plafond " << kMaxImagePixels << " px)\n";
    return false;
  }
  int w = 0, h = 0, channels = 0;
  unsigned char* pixels = stbi_load(full.string().c_str(), &w, &h, &channels, 4);  // force RGBA
  if (!pixels) {
    std::cerr << "draw_image: stb_image n'a pas pu decoder " << full
              << " (" << stbi_failure_reason() << ")\n";
    return false;
  }
  // Defense in depth: re-bound after decode (in case stbi_info underestimated).
  if (static_cast<long long>(w) * static_cast<long long>(h) > kMaxImagePixels) {
    std::cerr << "draw_image: image trop grande apres decode (" << w << "x" << h << ")\n";
    stbi_image_free(pixels);
    return false;
  }
  // PDFium expects BGRA for bitmaps. stb gives RGBA.
  // SECURITY: we do NOT pass the stb buffer to FPDFBitmap_CreateEx (which would
  // keep it by reference -> use-after-free when we free stb). We allocate
  // a FPDFBitmap_Create (PDFium manages the memory) then memcpy our RGBA
  // converted to BGRA into it.
  FPDF_BITMAP bmp = FPDFBitmap_Create(w, h, 1);  // 1 = alpha channel
  if (!bmp) {
    stbi_image_free(pixels);
    return false;
  }
  unsigned char* dst = static_cast<unsigned char*>(FPDFBitmap_GetBuffer(bmp));
  int stride = FPDFBitmap_GetStride(bmp);
  for (int y = 0; y < h; ++y) {
    unsigned char* row = dst + y * stride;
    const unsigned char* src = pixels + y * w * 4;
    for (int x = 0; x < w; ++x) {
      row[x * 4 + 0] = src[x * 4 + 2];  // B = R_src
      row[x * 4 + 1] = src[x * 4 + 1];  // G
      row[x * 4 + 2] = src[x * 4 + 0];  // R = B_src
      row[x * 4 + 3] = src[x * 4 + 3];  // A
    }
  }
  stbi_image_free(pixels);  // safe: PDFium has its own buffer
  bool ok = FPDFImageObj_SetBitmap(nullptr, 0, img, bmp) != 0;
  FPDFBitmap_Destroy(bmp);
  return ok;
}

static void applyOpDrawImage(FPDF_DOCUMENT doc, FPDF_PAGE page, const json& op,
                              const std::string& assetsDir) {
  if (!op.contains("bbox") || !op.contains("image_path")) return;
  const json& bbox = op["bbox"];
  if (!bbox.is_array() || bbox.size() != 4) return;
  std::string imgPath = op["image_path"].get<std::string>();
  if (imgPath.empty()) {
    std::cerr << "draw_image: image_path vide refuse\n";
    return;
  }
  // SECURITY: prevents path traversal. We accept a relative path (joined
  // to assetsDir) OR an absolute path (used as-is). In both cases we
  // verify below that the resolved path is under assetsDir.
  std::error_code ec;
  fs::path inputPath(imgPath);
  fs::path candidate = inputPath.is_absolute() ? inputPath : fs::path(assetsDir) / inputPath;
  if (!fs::exists(candidate, ec) || ec) {
    std::cerr << "draw_image: fichier introuvable " << candidate << "\n";
    return;
  }
  fs::path full = fs::canonical(candidate, ec);
  if (ec) {
    std::cerr << "draw_image: canonical echoue " << imgPath << "\n";
    return;
  }
  fs::path baseAbs = fs::canonical(fs::path(assetsDir), ec);
  if (ec) {
    std::cerr << "draw_image: canonical assetsDir echoue\n";
    return;
  }
  // lexically_relative returns a path starting with ".." if full is
  // outside baseAbs. More robust than string comparison (insensitive
  // to symlinks, OS case, separators). Explicit reject: empty (case
  // where paths are identical or non-comparable) and ".." (outside baseAbs).
  fs::path rel = full.lexically_relative(baseAbs);
  if (rel.empty()) {
    std::cerr << "draw_image: image_path hors assetsDir (rel empty) refuse : " << imgPath << "\n";
    return;
  }
  {
    const auto& s = rel.native();
    if (s.size() >= 2 && s[0] == '.' && s[1] == '.') {
      std::cerr << "draw_image: image_path hors assetsDir refuse : " << imgPath << "\n";
      return;
    }
  }
  FPDF_PAGEOBJECT img = FPDFPageObj_NewImageObj(doc);
  if (!img) return;
  if (!loadImageIntoObj(doc, img, full)) {
    std::cerr << "draw_image: chargement image echoue pour " << full << "\n";
    return;
  }
  // Position and size via matrix (w, 0, 0, h, x, y).
  // If fit="contain" (V2 engine default): preserves the image ratio by
  // inscribing it within the bbox (centered, the image may be smaller than
  // the bbox on one axis). Otherwise (fit="fill" or absent): stretches to the bbox.
  float pageH = FPDF_GetPageHeightF(page);
  float x0 = bbox[0].get<float>();
  float y0 = bbox[1].get<float>();
  float x1 = bbox[2].get<float>();
  float y1 = bbox[3].get<float>();
  float bboxW = x1 - x0;
  float bboxH = y1 - y0;
  float w = bboxW;
  float h = bboxH;
  float pdfX = x0;
  float pdfY = pageH - y1;
  std::string fit = op.value("fit", std::string{"contain"});
  if (fit == "contain") {
    unsigned int iW = 0, iH = 0;
    if (FPDFImageObj_GetImagePixelSize(img, &iW, &iH) && iW > 0 && iH > 0) {
      float imgRatio = static_cast<float>(iW) / static_cast<float>(iH);
      float bboxRatio = bboxW / bboxH;
      if (imgRatio > bboxRatio) {
        // image wider: we fill the width, reduce the height
        h = bboxW / imgRatio;
        pdfY = pageH - y1 + (bboxH - h) / 2.0f;
      } else {
        // image taller: we fill the height, reduce the width
        w = bboxH * imgRatio;
        pdfX = x0 + (bboxW - w) / 2.0f;
      }
    }
  }
  FPDFImageObj_SetMatrix(img, w, 0, 0, h, pdfX, pdfY);
  FPDFPage_InsertObject(page, img);
}

// fill_product_slot: disabled op. The extractor doesn't produce a
// strictly typed product_slot; the V2 engine uses set_text/insert_text
// + draw_image. We keep the handler empty for backward compat of the old
// sectionPlanner path (Claude per section).
static void applyOpFillProductSlot(FPDF_DOCUMENT doc, FPDF_PAGE page, const json& op,
                                    int sourcePage, const std::string& assetsDir) {
  (void)doc; (void)page; (void)op; (void)sourcePage; (void)assetsDir;
  // Silent no-op: the V2 engine never emits a fill_product_slot.
}

// Main operations dispatcher.
static void applyOp(FPDF_DOCUMENT doc, FPDF_PAGE page, const json& op,
                     int sourcePage, const std::string& assetsDir) {
  if (!op.contains("op")) return;
  std::string opType = op["op"].get<std::string>();
  if (opType == "set_text") applyOpSetText(doc, page, op, sourcePage);
  else if (opType == "insert_text") {
    // Outside the 2-pass: combined erase + insert.
    applyOpInsertTextErase(doc, page, op);
    applyOpInsertTextInsert(doc, page, op);
  }
  else if (opType == "erase_rect") applyOpEraseRect(doc, page, op);
  else if (opType == "remove_paths_in_bbox") applyOpRemovePathsInBbox(page, op);
  else if (opType == "remove_text_in_bbox") applyOpRemoveTextInBbox(page, op);
  else if (opType == "draw_circle") applyOpDrawCircle(doc, page, op);
  else if (opType == "draw_image") applyOpDrawImage(doc, page, op, assetsDir);
  else if (opType == "fill_product_slot") applyOpFillProductSlot(doc, page, op, sourcePage, assetsDir);
  else std::cerr << "Op inconnue: " << opType << "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// Saving via FPDF_SaveAsCopy
// ─────────────────────────────────────────────────────────────────────────────

// We use a combined struct: FPDF_FILEWRITE first (for the cast)
// + our context right after.
struct CombinedWriter {
  FPDF_FILEWRITE base;
  std::ofstream* out;
};

static int combinedWrite(FPDF_FILEWRITE* writer, const void* data, unsigned long size) {
  auto* w = reinterpret_cast<CombinedWriter*>(writer);
  w->out->write(reinterpret_cast<const char*>(data), size);
  return w->out->good() ? 1 : 0;
}

static bool saveDoc(FPDF_DOCUMENT doc, const std::string& outPath) {
  std::ofstream out(outPath, std::ios::binary | std::ios::trunc);
  if (!out) return false;
  CombinedWriter w;
  w.base.version = 1;
  w.base.WriteBlock = combinedWrite;
  w.out = &out;
  // Flag 0 = standard behavior, no incremental save
  return FPDF_SaveAsCopy(doc, &w.base, 0) != 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

int runRender(const std::string& planJsonPath,
              const std::string& templatePdfPath,
              const std::string& templatesDir,
              const std::string& assetsDir,
              const std::string& outPdfPath) {
  // 1. Load plan.json
  json plan;
  {
    std::ifstream f(planJsonPath);
    if (!f) {
      std::cerr << "Impossible d'ouvrir plan: " << planJsonPath << "\n";
      return 5;
    }
    try { f >> plan; }
    catch (const std::exception& e) {
      std::cerr << "Plan JSON invalide: " << e.what() << "\n";
      return 5;
    }
  }

  // 2. Load the extracted-page.json (to resolve slot_id -> bbox)
  loadExtractedPages(templatesDir);
  std::cout << "Extracted pages charges: " << g_extractedCache.size() << "\n";

  // 3. Init PDFium + open template source
  initPdfium();

  FPDF_DOCUMENT srcDoc = FPDF_LoadDocument(templatePdfPath.c_str(), nullptr);
  if (!srcDoc) {
    std::cerr << "Impossible d'ouvrir template: " << templatePdfPath << "\n";
    destroyPdfium();
    return 6;
  }

  // 4. Create the destination document
  FPDF_DOCUMENT dstDoc = FPDF_CreateNewDocument();
  if (!dstDoc) {
    std::cerr << "Impossible de creer le doc destination\n";
    FPDF_CloseDocument(srcDoc);
    destroyPdfium();
    return 7;
  }

  // 5. For each page of the plan: import + apply ops
  if (!plan.contains("pages") || !plan["pages"].is_array()) {
    std::cerr << "plan.pages absent ou invalide\n";
    FPDF_CloseDocument(dstDoc);
    FPDF_CloseDocument(srcDoc);
    destroyPdfium();
    return 8;
  }

  int dstIdx = 0;
  for (const auto& pp : plan["pages"]) {
    if (!pp.contains("source_page")) continue;
    int sourcePage = pp["source_page"].get<int>();

    // Import the source page (PDFium takes a 1-based page-spec, e.g. "5")
    std::string spec = std::to_string(sourcePage + 1);
    if (!FPDF_ImportPages(dstDoc, srcDoc, spec.c_str(), dstIdx)) {
      std::cerr << "ImportPages a echoue pour source " << sourcePage << "\n";
      continue;
    }

    // If operations mode: apply
    if (pp.contains("render") && pp["render"].is_object()) {
      const json& render = pp["render"];
      std::string mode = render.value("mode", std::string{});
      if (mode == "operations" && render.contains("operations")) {
        FPDF_PAGE page = FPDF_LoadPage(dstDoc, dstIdx);
        if (page) {
          // 2-PASS to prevent a white erase rect of op N+1 from erasing the text
          // inserted by op N (problem with adjacent slots: ref + color
          // side-by-side on a product sheet).
          //
          // PASS 1 (erase): paints all the white rects for set_text,
          //   fill_product_slot AND erase_rect. fill_product_slot is included
          //   here so its erase doesn't pollute pass 2 of set_text.
          //
          // PASS 2 (insert): inserts the texts + images. set_text and
          //   fill_product_slot use insertText directly (the white rect
          //   is already done in pass 1, no double-erase).
          float pageH = FPDF_GetPageHeightF(page);

          // ── PASS 1: erase ─────────────────────────────────────────────────
          for (const auto& op : render["operations"]) {
            if (!op.contains("op")) continue;
            std::string t = op["op"].get<std::string>();
            if (t == "set_text") {
              if (!op.contains("slot_id")) continue;
              float l, b, r, top, sz; unsigned rr, gg, bb; std::string fn;
              if (!resolveSlotForText(sourcePage, op["slot_id"].get<std::string>(),
                                      pageH, l, b, r, top, sz, rr, gg, bb, fn)) continue;
              eraseSlotZone(dstDoc, page, l, b, r, top);
            } else if (t == "fill_product_slot") {
              // Erases the zone of the name slot (the main set_text of fill).
              if (!op.contains("slot_id")) continue;
              float l, b, r, top, sz; unsigned rr, gg, bb; std::string fn;
              if (!resolveSlotForText(sourcePage, op["slot_id"].get<std::string>(),
                                      pageH, l, b, r, top, sz, rr, gg, bb, fn)) continue;
              eraseSlotZone(dstDoc, page, l, b, r, top);
            } else if (t == "erase_rect") {
              applyOpEraseRect(dstDoc, page, op);
            } else if (t == "remove_paths_in_bbox") {
              applyOpRemovePathsInBbox(page, op);
            } else if (t == "remove_text_in_bbox") {
              applyOpRemoveTextInBbox(page, op);
            } else if (t == "insert_text") {
              applyOpInsertTextErase(dstDoc, page, op);
            }
          }

          // ── PASS 2: insert ────────────────────────────────────────────────
          for (const auto& op : render["operations"]) {
            if (!op.contains("op")) continue;
            std::string t = op["op"].get<std::string>();
            if (t == "set_text") {
              // The white rect is already done in pass 1: just insertText.
              if (!op.contains("slot_id") || !op.contains("text")) continue;
              float l, b, r, top, size;
              unsigned rr = 0, gg = 0, bb = 0;
              std::string fontName;
              if (!resolveSlotForText(sourcePage, op["slot_id"].get<std::string>(),
                                      pageH, l, b, r, top, size, rr, gg, bb, fontName)) continue;
              insertText(dstDoc, page, op["text"].get<std::string>(), size, rr, gg, bb, l, b, fontName);
            } else if (t == "fill_product_slot") {
              // Erase already done in pass 1. We call fill which internally
              // calls applyOpSetText → we bypass the internal erase by
              // delegating directly to the erase+insert version for the name,
              // then draw_image for the image. Since fill calls
              // applyOpSetText which repaints white, we must work around it:
              // we call applyOpFillProductSlot but its internal erase is
              // now harmless because the zone is already white (a duplicate is
              // OK visually, no regression).
              applyOpFillProductSlot(dstDoc, page, op, sourcePage, assetsDir);
            } else if (t == "draw_circle") {
              applyOpDrawCircle(dstDoc, page, op);
            } else if (t == "draw_image") {
              applyOpDrawImage(dstDoc, page, op, assetsDir);
            } else if (t == "insert_text") {
              applyOpInsertTextInsert(dstDoc, page, op);
            }
          }
          FPDFPage_GenerateContent(page);
          FPDF_ClosePage(page);
        }
      }
    }
    dstIdx++;
  }

  // 6. Save
  // Bit-exact determinism NOT guaranteed: PDFium doesn't expose the API to
  // set CreationDate / ModDate / Producer / ID. Two successive runs
  // will produce PDFs that differ on these fields (and the PDF ID is
  // a random hash). To compare 2 regression outputs:
  //   1) extract the visual content via pdfimages + pdftotext
  //   2) or use qpdf --deterministic-id as post-process
  // Non-blocking for prod; relevant mostly for snapshot tests.
  if (!saveDoc(dstDoc, outPdfPath)) {
    std::cerr << "Sauvegarde a echoue: " << outPdfPath << "\n";
    FPDF_CloseDocument(dstDoc);
    FPDF_CloseDocument(srcDoc);
    destroyPdfium();
    return 9;
  }

  FPDF_CloseDocument(dstDoc);
  FPDF_CloseDocument(srcDoc);
  destroyPdfium();

  std::cout << "Rendering OK: " << dstIdx << " page(s) ecrites dans "
            << outPdfPath << "\n";
  return 0;
}

}  // namespace catgen
