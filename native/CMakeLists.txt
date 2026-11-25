cmake_minimum_required(VERSION 3.20)
project(MintPyNative LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(MintPy-Native WIN32
  src/main.cpp
  src/http_client.cpp
  src/tag_scanner.cpp
  src/audio_proxy.cpp
  src/data_store.cpp
  src/discord_ipc.cpp
)

target_compile_definitions(MintPy-Native PRIVATE UNICODE _UNICODE NDEBUG)
target_include_directories(MintPy-Native PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/include
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party
  ${CMAKE_CURRENT_SOURCE_DIR}/../tools/webview2/build/native/include
)

target_link_libraries(MintPy-Native PRIVATE
  winhttp ws2_32 bcrypt crypt32 gdiplus ole32 oleaut32 shell32 shlwapi uuid dwmapi user32 gdi32
)

if (MINGW)
  target_link_options(MintPy-Native PRIVATE -municode -static -static-libgcc -static-libstdc++)
endif()
