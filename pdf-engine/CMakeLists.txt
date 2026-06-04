# Recette CMake pour le binaire catgen-pdf.
# Compile avec g++ + linke contre PDFium (telecharge prebuilt dans le Dockerfile).
#
# Build local (depuis le dossier pdf-engine/) :
#   cmake -B build -S . -DPDFIUM_DIR=/opt/pdfium
#   cmake --build build --parallel

cmake_minimum_required(VERSION 3.20)
project(catgen-pdf CXX)

# Standard C++17 (suffit pour PDFium et nlohmann/json).
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Chemin vers le PDFium prebuilt. Surcharge depuis Dockerfile :
#   -DPDFIUM_DIR=/opt/pdfium
if(NOT DEFINED PDFIUM_DIR)
  set(PDFIUM_DIR "/opt/pdfium")
endif()

# Headers + lib PDFium.
include_directories(SYSTEM "${PDFIUM_DIR}/include")
link_directories("${PDFIUM_DIR}/lib")

# Source du binaire (pour l'instant juste main.cpp ; on ajoutera extract.cpp,
# render.cpp etc. au fil des lots).
set(SOURCES
  src/main.cpp
  src/extract.cpp
  src/render.cpp
)

add_executable(catgen-pdf ${SOURCES})
target_link_libraries(catgen-pdf PRIVATE pdfium)

# Options de compilation :
# -O2          : optimisation standard
# -Wall -Wextra : warnings
# -ffile-prefix-map : remplace le chemin source dans les debug symbols par
#   un chemin neutre, pour que 2 builds depuis 2 cwd differents produisent
#   le meme binaire (reproductibilite bit-exact).
target_compile_options(catgen-pdf PRIVATE
  -O2
  -Wall -Wextra
  "-ffile-prefix-map=${CMAKE_SOURCE_DIR}=."
)
