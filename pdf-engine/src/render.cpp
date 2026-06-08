// Implementation de la sous-commande "render".
//
// Strategie :
// 1. Charger plan.json + tous les extracted-page.json (templates/<nom>/).
// 2. Ouvrir template.pdf (source).
// 3. Creer un nouveau document destination.
// 4. Pour chaque entree dans plan.pages :
//    a. Importer la source_page depuis le template vers le document destination.
//    b. Si render.mode == "operations" : appliquer chaque op sur la page importee.
// 5. Fixer les metadonnees (CreationDate, ModDate, Producer) pour la
//    determinisme bit-exact.
// 6. Sauvegarder le PDF final.
//
// Convention bbox : le plan utilise origine top-left (idem schema). PDFium
// utilise origine bottom-left. On convertit a chaque op qui depose un objet.

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

// stb_image : decodage PNG/JPG/BMP/etc. vers bitmap RGBA. Single header,
// MIT, vendored sous pdf-engine/vendor/. Definition unique pour le linkage.
#define STB_IMAGE_IMPLEMENTATION
#define STB_IMAGE_STATIC
#include "../vendor/stb_image.h"

namespace catgen {

using json = nlohmann::ordered_json;
namespace fs = std::filesystem;

// ─────────────────────────────────────────────────────────────────────────────
// Cache des extracted-page.json (indexes par source page_number)
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

// Trouve un slot par id dans le extracted-page d'une source page. nullptr si absent.
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
// Helpers PDFium
// ─────────────────────────────────────────────────────────────────────────────

// Convertit une couleur "#rrggbb" en composantes 0-255.
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

// Convertit UTF-8 → buffer UTF-16LE termine par 0. ASCII/Latin-1/BMP.
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

// Peint un rect colore opaque sur la page. Default = blanc (efface). Si
// (r, g, b) precise = recouvre avec cette teinte (cas section_banner :
// orange du cartouche template a preserver). Coords PDFium (origine
// bottom-left).
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

// P4 audit : insertText utilise la font name du slot original quand fournie.
// Si PDFium ne trouve pas la font (pas embeddee, nom inconnu), il fallback
// silencieusement vers une font interne. On essaie quand meme les fonts
// builtin standard PDF (Helvetica, Times, Courier) si rien d'autre ne marche.
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
  // Matrice affine [a b c d e f] = rotation + translation.
  // rotation 90 CW  (texte vertical bottom-to-top) : (0, -1, 1, 0, x, y)
  // rotation 270 CW (texte vertical top-to-bottom) : (0, 1, -1, 0, x, y)
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
// Implementation des operations
// ─────────────────────────────────────────────────────────────────────────────

// Recupere la bbox d'un slot en convertissant top-left -> bottom-left PDFium.
// Retourne {left, bottom, right, top} si OK, false sinon.
static bool slotBboxToPdfium(const json& slot, float pageH,
                              float& left, float& bottom, float& right, float& top) {
  // Le label.bbox est plus precis que slot.bbox pour positionner le texte.
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
  // top-left → bottom-left : y_pdfium = pageH - y_topleft
  top = pageH - y0;
  bottom = pageH - y1;
  return true;
}

// ─── Helpers erase / insert separes pour le 2-pass ─────────────────────────

// Extrait style + coords d'un slot pour set_text. Retourne false si absent.
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

// Padding pour eraseSlotZone (resolution de slot par id). 50% absorbe les
// descenders/accents que PDFium n'inclut pas dans le bbox du glyph. Plus
// genereux que ERASE_PAD_INSERT_RATIO (35%) car la zone slot peut couvrir
// plusieurs lignes (banner, label).
static constexpr float ERASE_PAD_SLOT_RATIO = 0.5f;
static constexpr float ERASE_PAD_SLOT_MIN_PT = 6.0f;

// Efface la zone d'un slot.
static void eraseSlotZone(FPDF_DOCUMENT doc, FPDF_PAGE page,
                           float left, float bottom, float right, float top) {
  float h = top - bottom;
  float padY = std::max(h * ERASE_PAD_SLOT_RATIO, ERASE_PAD_SLOT_MIN_PT);
  paintWhiteRect(doc, page, left - 2.0f, bottom - padY, right + 2.0f, top + padY);
}

// ─── Operations completes (erase + insert, usage hors 2-pass) ───────────────

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

/** Supprime physiquement TOUS les paths (vector) ET images de la page dont
 *  la bbox est entierement contenue dans op.bbox. Utile quand un rect blanc
 *  ne suffit pas (path dessine par-dessus a cause d'un form xobject /
 *  d'un ordre de rendu PDFium inattendu). */
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
  // On NE supprime QUE les objets de petite taille (lignes decoratives,
  // micro-pictos) — surface < 1500 pt^2 par defaut. Empeche de supprimer
  // les cartouches de section, rubans structurels, header bands, etc.
  const float maxArea = op.value("max_area", 1500.0f);
  std::vector<FPDF_PAGEOBJECT> toRemove;
  int n = FPDFPage_CountObjects(page);
  for (int i = 0; i < n; ++i) {
    FPDF_PAGEOBJECT obj = FPDFPage_GetObject(page, i);
    if (!obj) continue;
    int type = FPDFPageObj_GetType(obj);
    // PATH only (pas IMAGE) : les images sont les cartouches de section,
    // pictos bitmap, etc. On les laisse — elles sont effacees au besoin
    // par les erase_rect classiques (polishResidualBitmaps).
    if (type != FPDF_PAGEOBJ_PATH) continue;
    float ol, ob, or_, ot;
    if (!FPDFPageObj_GetBounds(obj, &ol, &ob, &or_, &ot)) continue;
    // Object bbox entierement inscrit dans la erase bbox
    if (ol < left - 1 || or_ > right + 1 || ob < bottom - 1 || ot > top + 1) continue;
    // Filtre taille : on garde les objets larges (= structurels)
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

/** Supprime physiquement les TEXT objects de la page dont la bbox est
 *  inscrite dans la bbox de l'op. Sert a effacer un numero de page sur
 *  fond photo sans laisser de tache visible (un erase_rect blanc/colore
 *  serait visible sur la photo). Equivalent textuel de applyOpRemovePathsInBbox. */
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
    // Object entierement inscrit dans la bbox cible (avec 1pt tolerance)
    if (ol < left - 1 || or_ > right + 1 || ob < bottom - 1 || ot > top + 1) continue;
    toRemove.push_back(obj);
  }
  for (auto obj : toRemove) {
    if (FPDFPage_RemoveObject(page, obj)) {
      FPDFPageObj_Destroy(obj);
    }
  }
}

// Echantillonne la couleur de fond dans une fine bande JUSTE AU-DESSUS du rect
// (left..right, en coords PDFium bottom-left) en rendant la page courante.
// Sert a effacer un numero de page sur fond photo avec la teinte locale (pas de
// bloc blanc voyant). Retourne false si echec (le caller garde alors le blanc).
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
  FPDFBitmap_FillRect(bmp, 0, 0, W, H, 0xFFFFFFFF);  // fond blanc opaque
  FPDF_RenderPageBitmap(bmp, page, 0, 0, W, H, 0, 0);
  unsigned char* buf = static_cast<unsigned char*>(FPDFBitmap_GetBuffer(bmp));
  int stride = FPDFBitmap_GetStride(bmp);
  // Bande pdfium y dans [top+1, top+6] = juste au-dessus du numero (= photo,
  // le running header voisin est a GAUCHE pas au-dessus). device y (origine
  // haut-gauche) = (pageH - pdfium_y) * scale.
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
  // sample_bg : efface avec la teinte du fond local (footer numero sur photo
  // claire) au lieu du blanc → pas de bloc blanc visible. Fallback blanc si KO.
  if (op.value("sample_bg", false)) {
    unsigned sr, sg, sb;
    if (sampleBgColor(page, x0, x1, pageH - y0, sr, sg, sb)) {
      r = sr; g = sg; b = sb;
    }
  }
  paintColoredRect(doc, page, x0, pageH - y1, x1, pageH - y0, r, g, b);
}

// V2 engine : insertion de texte autonome (sans dependance slot_id).
// Le caller fournit bbox + font + size + color. La bbox est en coords schema
// (origine top-left). L'erase de la zone est inclus en PASS 1 (cf 2-pass
// principal). L'insertion text se fait en PASS 2 a la baseline (bbox[3]).
static void applyOpInsertTextErase(FPDF_DOCUMENT doc, FPDF_PAGE page, const json& op) {
  if (!op.contains("bbox")) return;
  // Skip si no_erase=true : le caller veut juste reecrire un glyphe
  // sans tache blanche (renum pages sur fond photo).
  if (op.value("no_erase", false)) return;
  const json& bbox = op["bbox"];
  if (!bbox.is_array() || bbox.size() != 4) return;
  float pageH = FPDF_GetPageHeightF(page);
  float x0 = bbox[0].get<float>();
  float y0 = bbox[1].get<float>();
  float x1 = bbox[2].get<float>();
  float y1 = bbox[3].get<float>();
  // Padding pour applyOpInsertTextErase (auto-erase blanc autour de bbox
  // d'un insert_text). Ratio 35% plus serre que ERASE_PAD_SLOT_RATIO (50%)
  // car la bbox d'insert_text fournie par le caller est deja calculee
  // serree autour du texte attendu (le caller a la geometrie precise).
  // Min 8pt = un peu plus large que le slot pour les ligne decoratives
  // qui longent le nom (vu sur ER : trait fin separateur header/specs).
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
  // baseline ~ bottom du span - petit offset. y_pdfium = pageH - y1 + kBaselineOffsetPt.
  // Cette valeur est partagee : si tu la modifies, change aussi INSERT_TEXT_BASELINE_OFFSET
  // dans src/v2/insertText.ts (TS doit compenser car il connait la formule du render).
  constexpr float kBaselineOffsetPt = 2.0f;
  int rotation = op.value("rotation", 0);
  if (rotation == 90 || rotation == 270) {
    // Texte vertical : x0 = colonne, y position = base du texte en coords PDFium.
    // Pour rotation 90 (bottom-to-top comme dans les rubans), le point d'ancrage
    // est le coin bas-gauche du texte en coordonnees page PDFium (y=0 = bottom).
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
  // Cercle via 4 Bezier cubics (standard PDF). Plus propre que polygone
  // 32 segments : aretes invisibles meme zoome 200%. Magic constant
  // 0.5522847498 = (4/3) * tan(pi/8) — controle de courbure pour qu'un
  // quart de cercle Bezier matche le cercle reel a < 0.03% pres.
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

// Charge une image (JPG, PNG, BMP, etc.) dans un FPDF_PAGEOBJECT via stb_image.
//
// On n'utilise PAS FPDFImageObj_LoadJpegFile (path natif JPG rapide) : son
// FILEACCESS demande un buffer persistant via m_Param. Si on charge plusieurs
// JPG d'affilee, un buffer thread_local partage est ecrase par chaque appel ;
// les images chargees AVANT perdent leur data quand PDFium lit lazily a
// GenerateContent. Le path stb decode tout de suite en bitmap qu'on copie
// dans un buffer PDFium possede par PDFium (independant des chargements
// suivants).
// Plafond de pixels avant decode : borne l'allocation (w*h*4 octets) face a une
// image-bombe (ex PNG 64000x64000 = 16 Go RGBA). 64 MP (~256 Mo RGBA) couvre
// tout scan produit legitime tout en bloquant les decompression bombs.
static constexpr long long kMaxImagePixels = 64LL * 1000 * 1000;

static bool loadImageIntoObj(FPDF_DOCUMENT doc, FPDF_PAGEOBJECT img, const fs::path& full) {
  // SECURITE : lit d'abord les dimensions SANS decoder (stbi_info), pour
  // refuser une image hors plafond AVANT que stb_image n'alloue le buffer.
  // Si stbi_info echoue, on REFUSE (plutot que de laisser stbi_load decoder
  // a l'aveugle) : ainsi le plafond est une vraie garantie, pas un best-effort.
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
  // Defense en profondeur : re-borne apres decode (si stbi_info a sous-estime).
  if (static_cast<long long>(w) * static_cast<long long>(h) > kMaxImagePixels) {
    std::cerr << "draw_image: image trop grande apres decode (" << w << "x" << h << ")\n";
    stbi_image_free(pixels);
    return false;
  }
  // PDFium attend BGRA pour les bitmaps. stb donne RGBA.
  // SECURITE : on ne passe PAS le buffer stb a FPDFBitmap_CreateEx (qui le
  // garderait par reference -> use-after-free quand on libere stb). On alloue
  // un FPDFBitmap_Create (PDFium gere la memoire) puis on memcpy notre RGBA
  // converti en BGRA dedans.
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
  stbi_image_free(pixels);  // safe : PDFium a son propre buffer
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
  // SECURITE : empeche path traversal. On accepte path relatif (joint
  // a assetsDir) OU path absolu (utilise tel quel). Dans les 2 cas on
  // verifie en bas que le path resolu est sous assetsDir.
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
  // lexically_relative retourne un path commencant par ".." si full est
  // hors de baseAbs. Plus robuste que la comparaison string (insensible
  // aux symlinks, casse OS, separateurs). Reject explicite : empty (cas
  // ou paths identiques ou non-comparables) et ".." (sortie de baseAbs).
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
  // Positionner et dimensionner via matrice (w, 0, 0, h, x, y).
  // Si fit="contain" (defaut V2 engine) : preserve le ratio de l'image en
  // l'inscrivant dans la bbox (centre, l'image peut etre plus petite que
  // la bbox sur un axe). Sinon (fit="fill" ou absent) : etire a la bbox.
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
        // image plus large : on remplit width, on reduit height
        h = bboxW / imgRatio;
        pdfY = pageH - y1 + (bboxH - h) / 2.0f;
      } else {
        // image plus haute : on remplit height, on reduit width
        w = bboxH * imgRatio;
        pdfX = x0 + (bboxW - w) / 2.0f;
      }
    }
  }
  FPDFImageObj_SetMatrix(img, w, 0, 0, h, pdfX, pdfY);
  FPDFPage_InsertObject(page, img);
}

// fill_product_slot : op desactivee. L'extracteur ne produit pas de
// product_slot strictement type ; l'engine V2 utilise set_text/insert_text
// + draw_image. On garde le handler vide pour la retro-compat de l'ancien
// path sectionPlanner (Claude par section).
static void applyOpFillProductSlot(FPDF_DOCUMENT doc, FPDF_PAGE page, const json& op,
                                    int sourcePage, const std::string& assetsDir) {
  (void)doc; (void)page; (void)op; (void)sourcePage; (void)assetsDir;
  // No-op silencieux : l'engine V2 n'emet jamais de fill_product_slot.
}

// Dispatcher principal des operations.
static void applyOp(FPDF_DOCUMENT doc, FPDF_PAGE page, const json& op,
                     int sourcePage, const std::string& assetsDir) {
  if (!op.contains("op")) return;
  std::string opType = op["op"].get<std::string>();
  if (opType == "set_text") applyOpSetText(doc, page, op, sourcePage);
  else if (opType == "insert_text") {
    // Hors 2-pass : erase + insert combine.
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
// Sauvegarde via FPDF_SaveAsCopy
// ─────────────────────────────────────────────────────────────────────────────

// On utilise une struct combinee : FPDF_FILEWRITE en premier (pour le cast)
// + notre contexte juste apres.
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
  // Flag 0 = comportement standard, pas d'incremental save
  return FPDF_SaveAsCopy(doc, &w.base, 0) != 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entree publique
// ─────────────────────────────────────────────────────────────────────────────

int runRender(const std::string& planJsonPath,
              const std::string& templatePdfPath,
              const std::string& templatesDir,
              const std::string& assetsDir,
              const std::string& outPdfPath) {
  // 1. Charger plan.json
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

  // 2. Charger les extracted-page.json (pour resoudre slot_id -> bbox)
  loadExtractedPages(templatesDir);
  std::cout << "Extracted pages charges: " << g_extractedCache.size() << "\n";

  // 3. Init PDFium + ouvrir template source
  initPdfium();

  FPDF_DOCUMENT srcDoc = FPDF_LoadDocument(templatePdfPath.c_str(), nullptr);
  if (!srcDoc) {
    std::cerr << "Impossible d'ouvrir template: " << templatePdfPath << "\n";
    destroyPdfium();
    return 6;
  }

  // 4. Creer le document destination
  FPDF_DOCUMENT dstDoc = FPDF_CreateNewDocument();
  if (!dstDoc) {
    std::cerr << "Impossible de creer le doc destination\n";
    FPDF_CloseDocument(srcDoc);
    destroyPdfium();
    return 7;
  }

  // 5. Pour chaque page du plan : importer + appliquer ops
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

    // Importer la source page (PDFium prend une page-spec 1-based, ex "5")
    std::string spec = std::to_string(sourcePage + 1);
    if (!FPDF_ImportPages(dstDoc, srcDoc, spec.c_str(), dstIdx)) {
      std::cerr << "ImportPages a echoue pour source " << sourcePage << "\n";
      continue;
    }

    // Si mode operations : appliquer
    if (pp.contains("render") && pp["render"].is_object()) {
      const json& render = pp["render"];
      std::string mode = render.value("mode", std::string{});
      if (mode == "operations" && render.contains("operations")) {
        FPDF_PAGE page = FPDF_LoadPage(dstDoc, dstIdx);
        if (page) {
          // 2-PASS pour eviter qu'un rect blanc d'erase N+1 efface le texte
          // insere par l'op N (probleme avec slots adjacents : ref + couleur
          // cote-a-cote sur une fiche produit).
          //
          // PASS 1 (erase) : peint tous les rects blancs pour set_text,
          //   fill_product_slot ET erase_rect. fill_product_slot est inclus
          //   ici pour que son erase ne pollue pas le pass 2 de set_text.
          //
          // PASS 2 (insert) : insere les textes + images. set_text et
          //   fill_product_slot utilisent directement insertText (le rect
          //   blanc est deja fait en pass 1, pas de double-erase).
          float pageH = FPDF_GetPageHeightF(page);

          // ── PASS 1 : erase ────────────────────────────────────────────────
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
              // Efface la zone du slot de nom (le principal set_text de fill).
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

          // ── PASS 2 : insert ───────────────────────────────────────────────
          for (const auto& op : render["operations"]) {
            if (!op.contains("op")) continue;
            std::string t = op["op"].get<std::string>();
            if (t == "set_text") {
              // Le rect blanc est deja fait en pass 1 : juste insertText.
              if (!op.contains("slot_id") || !op.contains("text")) continue;
              float l, b, r, top, size;
              unsigned rr = 0, gg = 0, bb = 0;
              std::string fontName;
              if (!resolveSlotForText(sourcePage, op["slot_id"].get<std::string>(),
                                      pageH, l, b, r, top, size, rr, gg, bb, fontName)) continue;
              insertText(dstDoc, page, op["text"].get<std::string>(), size, rr, gg, bb, l, b, fontName);
            } else if (t == "fill_product_slot") {
              // Erase deja fait en pass 1. On appelle fill qui internement
              // appelle applyOpSetText → on bypass l'erase interne en
              // delegant directement a la version erase+insert pour le nom,
              // puis draw_image pour l'image. Puisque fill appelle
              // applyOpSetText qui repeint blanc, on doit contourner :
              // on appelle applyOpFillProductSlot mais son erase interne est
              // maintenant inoffensif car la zone est deja blanche (doublon
              // OK visuellement, pas de regression).
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

  // 6. Sauvegarder
  // Determinisme bit-exact NON garanti : PDFium n'expose pas l'API pour
  // fixer CreationDate / ModDate / Producer / ID. Deux runs successifs
  // produiront des PDFs qui different sur ces champs (et l'ID PDF est
  // un hash random). Pour comparer 2 outputs de regression :
  //   1) extraire le contenu visuel via pdfimages + pdftotext
  //   2) ou utiliser qpdf --deterministic-id en post-process
  // Non bloquant pour la prod ; pertinent surtout pour les tests snapshots.
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
