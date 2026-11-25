#!/usr/bin/env python3
"""
MintPy Android APK Builder
Compiles standalone Java/XML sources in `android/` + web UI in `src_mobile/` & `shared/`,
reads version automatically from `package.json`, signs with v2/v3, and cleans stale APKs.
"""
import json
import os
import shutil
import subprocess
from PIL import Image


def compute_version_code(version_str: str) -> int:
    parts = [int(x) for x in version_str.split("-")[0].split(".")[:3]]
    while len(parts) < 3:
        parts.append(0)
    return parts[0] * 10000 + parts[1] * 100 + parts[2]


def main():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(base_dir, "package.json"), "r", encoding="utf-8") as pf:
        pkg = json.load(pf)

    version_name = str(pkg.get("version", "6.0.0")).strip()
    version_code = str(compute_version_code(version_name))

    android_src_root = os.path.join(base_dir, "android")
    tools_dir = os.path.join(base_dir, "tools")
    jdk_home = os.path.join(tools_dir, "jdk-17.0.20.1+1")
    jdk_bin = os.path.join(jdk_home, "bin")
    sdk_dir = os.path.join(tools_dir, "android-sdk")
    build_tools = os.path.join(sdk_dir, "build-tools", "34.0.0")
    android_jar = os.path.join(sdk_dir, "platforms", "android-34", "android.jar")
    keystore = os.path.join(tools_dir, "mintpy-debug.keystore")

    aapt2 = os.path.join(build_tools, "aapt2.exe")
    d8_bat = os.path.join(build_tools, "d8.bat")
    zipalign = os.path.join(build_tools, "zipalign.exe")
    apksigner_bat = os.path.join(build_tools, "apksigner.bat")
    javac = os.path.join(jdk_bin, "javac.exe")
    jar_exe = os.path.join(jdk_bin, "jar.exe")

    build_dir = os.path.join(base_dir, "build_android")
    if os.path.exists(build_dir):
        shutil.rmtree(build_dir)
    os.makedirs(build_dir, exist_ok=True)

    # 1. Copy XML resources & generate mipmap launcher icons
    res_dir = os.path.join(build_dir, "res")
    shutil.copytree(os.path.join(android_src_root, "res"), res_dir)

    logo = Image.open(os.path.join(base_dir, "assets", "mintpy-logo.png")).convert("RGBA")
    icon_sizes = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for folder, size in icon_sizes.items():
        folder_path = os.path.join(res_dir, folder)
        os.makedirs(folder_path, exist_ok=True)
        logo.resize((size, size), Image.Resampling.LANCZOS).save(os.path.join(folder_path, "ic_launcher.png"))

    # 2. Stamp AndroidManifest.xml with package.json version
    with open(os.path.join(android_src_root, "AndroidManifest.xml"), "r", encoding="utf-8") as mf:
        manifest_tpl = mf.read()
    manifest_xml = (
        manifest_tpl
        .replace("${VERSION_CODE}", version_code)
        .replace("${VERSION_NAME}", version_name)
    )
    manifest_path = os.path.join(build_dir, "AndroidManifest.xml")
    with open(manifest_path, "w", encoding="utf-8") as mf:
        mf.write(manifest_xml)

    # 3. Stage web assets: src_mobile -> assets/src, shared -> assets/shared, mobile themes -> assets/assets
    assets_dest = os.path.join(build_dir, "assets")
    os.makedirs(assets_dest, exist_ok=True)
    shutil.copytree(os.path.join(base_dir, "src_mobile"), os.path.join(assets_dest, "src"))
    shutil.copytree(os.path.join(base_dir, "shared"), os.path.join(assets_dest, "shared"))

    mobile_assets_dir = os.path.join(assets_dest, "assets")
    os.makedirs(os.path.join(mobile_assets_dir, "themes"), exist_ok=True)
    shutil.copy2(os.path.join(base_dir, "assets", "mintpy-logo.png"), os.path.join(mobile_assets_dir, "mintpy-logo.png"))
    shutil.copytree(
        os.path.join(base_dir, "assets", "themes", "mobile"),
        os.path.join(mobile_assets_dir, "themes", "mobile"),
        ignore=shutil.ignore_patterns("test-*")
    )

    compiled_res = os.path.join(build_dir, "compiled_res")
    gen_dir = os.path.join(build_dir, "gen")
    bin_dir = os.path.join(build_dir, "bin")
    obj_dir = os.path.join(bin_dir, "obj")
    for d in (compiled_res, gen_dir, bin_dir, obj_dir):
        os.makedirs(d, exist_ok=True)

    env = os.environ.copy()
    env["JAVA_HOME"] = jdk_home
    env["PATH"] = f"{jdk_bin};{build_tools};" + env.get("PATH", "")

    print(f"[1/6] aapt2 compile (MintPy v{version_name} / code {version_code})...")
    res_zip = os.path.join(compiled_res, "resources.zip")
    subprocess.check_call([aapt2, "compile", "--dir", res_dir, "-o", res_zip], env=env)

    print("[2/6] aapt2 link...")
    unaligned_apk = os.path.join(bin_dir, "unaligned.apk")
    subprocess.check_call([
        aapt2, "link",
        "-I", android_jar,
        res_zip,
        "--manifest", manifest_path,
        "-o", unaligned_apk,
        "--java", gen_dir,
        "--min-sdk-version", "24",
        "--target-sdk-version", "34",
        "--auto-add-overlay"
    ], env=env)

    print("[3/6] javac...")
    java_sources = [os.path.join(gen_dir, "com", "mintpy", "app", "R.java")]
    for root_w, _, files in os.walk(os.path.join(android_src_root, "java")):
        for f in sorted(files):
            if f.endswith(".java"):
                java_sources.append(os.path.join(root_w, f))

    subprocess.check_call(
        [javac, "-encoding", "UTF-8", "-cp", android_jar, "-d", obj_dir] + java_sources,
        env=env
    )

    print("[4/6] d8...")
    class_files = []
    for root_w, _, files in os.walk(obj_dir):
        for f in sorted(files):
            if f.endswith(".class"):
                class_files.append(os.path.join(root_w, f))
    subprocess.check_call(["cmd.exe", "/c", d8_bat, "--lib", android_jar, "--output", bin_dir] + class_files, env=env)

    print("[5/6] Packaging classes.dex and web assets with jar tool...")
    subprocess.check_call([jar_exe, "-uf", unaligned_apk, "-C", bin_dir, "classes.dex"], env=env)
    subprocess.check_call([jar_exe, "-uf", unaligned_apk, "-C", build_dir, "assets"], env=env)

    print("[6/6] zipalign & apksigner...")
    releases_dir = os.path.join(base_dir, "releases")
    os.makedirs(releases_dir, exist_ok=True)
    aligned_apk = os.path.join(releases_dir, f"MintPy-v{version_name}.apk")
    if os.path.exists(aligned_apk):
        os.remove(aligned_apk)

    subprocess.check_call([zipalign, "-v", "-p", "4", unaligned_apk, aligned_apk], env=env)
    subprocess.check_call([
        "cmd.exe", "/c", apksigner_bat, "sign",
        "--ks", keystore,
        "--ks-pass", "pass:android",
        "--key-pass", "pass:android",
        "--v1-signing-enabled", "true",
        "--v2-signing-enabled", "true",
        "--v3-signing-enabled", "true",
        "--v4-signing-enabled", "false",
        aligned_apk
    ], env=env)
    subprocess.check_call(["cmd.exe", "/c", apksigner_bat, "verify", "--verbose", aligned_apk], env=env)

    target_apk_lower = os.path.basename(aligned_apk).lower()
    for name in os.listdir(releases_dir):
        lower = name.lower()
        if (lower.endswith(".apk") or lower.endswith(".apk.idsig")) and lower != target_apk_lower:
            old_path = os.path.join(releases_dir, name)
            try:
                if os.path.isfile(old_path):
                    os.remove(old_path)
                    print(f"Removed old APK artifact: {name}")
            except Exception as err:
                print(f"Warning: could not remove {name}: {err}")

    shutil.rmtree(build_dir, ignore_errors=True)
    apk_size_mb = os.path.getsize(aligned_apk) / (1024 * 1024)
    print(f"\nSUCCESS! MintPy Android APK built and signed:\n  -> {aligned_apk} ({apk_size_mb:.2f} MB)")


if __name__ == "__main__":
    main()
