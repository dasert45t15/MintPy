# -*- coding: utf-8 -*-
"""
Script to generate a clean, authentic, non-AI-sounding Word document (.docx)
for the MintPy school project passport and justification according to teacher requirements.
"""

import os
import docx
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn

def set_cell_background(cell, fill_hex):
    """Sets background color of a table cell."""
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{fill_hex}"/>')
    tc_pr.append(shd)

def set_cell_margins(cell, top=100, bottom=100, left=150, right=150):
    """Sets cell padding (in dxa: 20 dxa = 1 pt)."""
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_mar = parse_xml(
        f'<w:tcMar {nsdecls("w")}>'
        f'  <w:top w:w="{top}" w:type="dxa"/>'
        f'  <w:bottom w:w="{bottom}" w:type="dxa"/>'
        f'  <w:left w:w="{left}" w:type="dxa"/>'
        f'  <w:right w:w="{right}" w:type="dxa"/>'
        f'</w:tcMar>'
    )
    tc_pr.append(tc_mar)

def set_table_borders(table, color="B0BEC5", sz="4"):
    """Sets subtle clean borders on table."""
    tbl_pr = table._tbl.tblPr
    borders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>'
        f'  <w:top w:val="single" w:sz="{sz}" w:space="0" w:color="{color}"/>'
        f'  <w:bottom w:val="single" w:sz="{sz}" w:space="0" w:color="{color}"/>'
        f'  <w:insideH w:val="single" w:sz="{sz}" w:space="0" w:color="{color}"/>'
        f'  <w:left w:val="none"/>'
        f'  <w:right w:val="none"/>'
        f'  <w:insideV w:val="none"/>'
        f'</w:tblBorders>'
    )
    tbl_pr.append(borders)

def add_callout_box(doc, text, title=None):
    """Adds a stylish callout box for quotes or note highlights."""
    tbl = doc.add_table(rows=1, cols=1)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl.autofit = False
    
    cell = tbl.cell(0, 0)
    cell.width = Inches(6.3)
    set_cell_background(cell, "F4F6F9")
    set_cell_margins(cell, top=140, bottom=140, left=200, right=200)
    
    # Left border only (accent color)
    tc_pr = cell._tc.get_or_add_tcPr()
    border = parse_xml(
        f'<w:tcBorders {nsdecls("w")}>'
        f'  <w:top w:val="none"/>'
        f'  <w:left w:val="single" w:sz="24" w:space="0" w:color="3B82F6"/>'
        f'  <w:bottom w:val="none"/>'
        f'  <w:right w:val="none"/>'
        f'</w:tcBorders>'
    )
    tc_pr.append(border)
    
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.line_spacing = 1.15
    if title:
        run_title = p.add_run(title + "\n")
        run_title.bold = True
        run_title.font.name = "Times New Roman"
        run_title.font.size = Pt(11)
        run_title.font.color.rgb = RGBColor(0x1E, 0x3A, 0x8A)
    
    run_text = p.add_run(text)
    run_text.font.name = "Times New Roman"
    run_text.font.size = Pt(11)
    run_text.italic = True
    run_text.font.color.rgb = RGBColor(0x33, 0x41, 0x55)
    
    # Empty paragraph after
    p_after = doc.add_paragraph()
    p_after.paragraph_format.space_before = Pt(0)
    p_after.paragraph_format.space_after = Pt(4)

def build_document():
    doc = Document()
    
    # Page setup (Standard school project margins: Left 30mm, Right 15mm, Top 20mm, Bottom 20mm)
    section = doc.sections[0]
    section.left_margin = Inches(1.18)   # 30 mm
    section.right_margin = Inches(0.59)  # 15 mm
    section.top_margin = Inches(0.79)    # 20 mm
    section.bottom_margin = Inches(0.79) # 20 mm
    section.page_width = Inches(8.27)    # A4
    section.page_height = Inches(11.69)
    
    # Configure base style
    normal_style = doc.styles['Normal']
    normal_style.font.name = 'Times New Roman'
    normal_style.font.size = Pt(12)
    normal_style.font.color.rgb = RGBColor(0x1F, 0x29, 0x37)
    
    # ==================== TITUL PAGE ====================
    p_header = doc.add_paragraph()
    p_header.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_header.paragraph_format.space_after = Pt(4)
    p_header.paragraph_format.line_spacing = 1.0
    r = p_header.add_run("Муниципальное общеобразовательное учреждение\n«Средняя общеобразовательная школа»\n")
    r.font.size = Pt(10.5)
    r.font.color.rgb = RGBColor(0x47, 0x55, 0x69)
    
    # Logo if available
    logo_path = r"D:\mintpy\assets\mintpy-logo.png"
    if os.path.exists(logo_path):
        p_logo = doc.add_paragraph()
        p_logo.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p_logo.paragraph_format.space_before = Pt(16)
        p_logo.paragraph_format.space_after = Pt(16)
        p_logo.add_run().add_picture(logo_path, width=Inches(1.2))
    else:
        p_space = doc.add_paragraph()
        p_space.paragraph_format.space_before = Pt(36)
    
    p_proj = doc.add_paragraph()
    p_proj.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_proj.paragraph_format.space_before = Pt(20)
    p_proj.paragraph_format.space_after = Pt(8)
    r_proj = p_proj.add_run("ИНДИВИДУАЛЬНЫЙ УЧЕБНЫЙ ПРОЕКТ")
    r_proj.bold = True
    r_proj.font.size = Pt(15)
    r_proj.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)
    
    p_subj = doc.add_paragraph()
    p_subj.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_subj.paragraph_format.space_after = Pt(24)
    r_subj = p_subj.add_run("по предметной области «Информатика и ИКТ»")
    r_subj.font.size = Pt(12)
    r_subj.font.color.rgb = RGBColor(0x47, 0x55, 0x69)
    
    p_topic_lbl = doc.add_paragraph()
    p_topic_lbl.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_topic_lbl.paragraph_format.space_after = Pt(4)
    r_lbl = p_topic_lbl.add_run("ТЕМА ПРОЕКТА:")
    r_lbl.bold = True
    r_lbl.font.size = Pt(12)
    r_lbl.font.color.rgb = RGBColor(0x25, 0x63, 0xEB)
    
    p_topic = doc.add_paragraph()
    p_topic.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_topic.paragraph_format.space_before = Pt(4)
    p_topic.paragraph_format.space_after = Pt(60)
    p_topic.paragraph_format.line_spacing = 1.2
    r_topic = p_topic.add_run("«Разработка кроссплатформенного мультимедийного приложения \"MintPy\" с атмосферным интерфейсом и интеграцией веб-источников»")
    r_topic.bold = True
    r_topic.font.size = Pt(15)
    
    # Author & Supervisor block (aligned to right)
    p_info = doc.add_paragraph()
    p_info.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    p_info.paragraph_format.line_spacing = 1.25
    p_info.paragraph_format.space_after = Pt(80)
    
    r1 = p_info.add_run("Выполнил:\n")
    r1.font.size = Pt(11.5)
    r1.bold = True
    
    r2 = p_info.add_run("обучающийся __ класса\n")
    r2.font.size = Pt(11.5)
    
    r3 = p_info.add_run("Иван (Dasert)\n\n")
    r3.font.size = Pt(11.5)
    r3.bold = True
    
    r4 = p_info.add_run("Руководитель проекта:\n")
    r4.font.size = Pt(11.5)
    r4.bold = True
    
    r5 = p_info.add_run("Учитель информатики\n________________________ (Ф.И.О.)\n")
    r5.font.size = Pt(11.5)
    
    p_city = doc.add_paragraph()
    p_city.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_city.paragraph_format.space_before = Pt(40)
    r_city = p_city.add_run("2026 г.")
    r_city.font.size = Pt(11)
    
    doc.add_page_break()
    
    # ==================== HELPERS FOR HEADINGS ====================
    def add_h1(text):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(18)
        p.paragraph_format.space_after = Pt(8)
        p.paragraph_format.keep_with_next = True
        r = p.add_run(text)
        r.bold = True
        r.font.size = Pt(14)
        r.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)
        return p

    def add_h2(text):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(12)
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.keep_with_next = True
        r = p.add_run(text)
        r.bold = True
        r.font.size = Pt(12.5)
        r.font.color.rgb = RGBColor(0x1E, 0x3A, 0x8A)
        return p

    def add_body(text, bold_prefix=None, space_after=4):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(space_after)
        p.paragraph_format.line_spacing = 1.15
        p.paragraph_format.first_line_indent = Inches(0.4)
        if bold_prefix:
            rb = p.add_run(bold_prefix)
            rb.bold = True
        p.add_run(text)
        return p

    # ==================== SECTION 1: PASSPORT ====================
    add_h1("1. Паспорт индивидуального учебного проекта")
    
    table_pass = doc.add_table(rows=8, cols=2)
    table_pass.alignment = WD_TABLE_ALIGNMENT.CENTER
    table_pass.autofit = False
    set_table_borders(table_pass, color="CBD5E1", sz="6")
    
    passport_data = [
        ("Тема проекта", "Разработка кроссплатформенного мультимедийного приложения \"MintPy\" с атмосферным интерфейсом и интеграцией веб-источников"),
        ("Учебный предмет", "Информатика и ИКТ"),
        ("Автор проекта", "Иван (обучающийся __ класса)"),
        ("Руководитель проекта", "Учитель информатики __________________________"),
        ("Тип проекта", "Практико-ориентированный, исследовательский, конструкторский"),
        ("Продукт проекта", "Рабочее кроссплатформенное программное обеспечение: десктопное приложение для ПК (Windows/Linux) и автономное мобильное приложение для Android (MintPy.apk)"),
        ("Сроки реализации", "Сентябрь 2025 г. — Апрель 2026 г. (1 учебный год)"),
        ("Используемые технологии", "JavaScript (ES6+), HTML5, CSS3, Web Audio API, Canvas 2D, Node.js, Electron, Android WebView/Java, aapt2/d8 toolchain")
    ]
    
    col_widths = [Inches(1.8), Inches(4.5)]
    for i, (k, v) in enumerate(passport_data):
        row = table_pass.rows[i]
        
        c0 = row.cells[0]
        c0.width = col_widths[0]
        set_cell_background(c0, "F8FAFC")
        set_cell_margins(c0, top=100, bottom=100, left=120, right=120)
        p0 = c0.paragraphs[0]
        p0.paragraph_format.space_before = Pt(0)
        p0.paragraph_format.space_after = Pt(0)
        p0.paragraph_format.line_spacing = 1.05
        r0 = p0.add_run(k)
        r0.bold = True
        r0.font.size = Pt(10.5)
        r0.font.color.rgb = RGBColor(0x33, 0x41, 0x55)
        
        c1 = row.cells[1]
        c1.width = col_widths[1]
        set_cell_margins(c1, top=100, bottom=100, left=120, right=120)
        p1 = c1.paragraphs[0]
        p1.paragraph_format.space_before = Pt(0)
        p1.paragraph_format.space_after = Pt(0)
        p1.paragraph_format.line_spacing = 1.05
        r1 = p1.add_run(v)
        r1.font.size = Pt(10.5)

    doc.add_paragraph().paragraph_format.space_after = Pt(6)

    # ==================== SECTION 2: JUSTIFICATION (NOTEBOOK TASK) ====================
    add_h1("2. Обоснование выбора темы (Задание в тетради)")
    
    add_callout_box(
        doc,
        "«Первоначальная формулировка темы может носить не окончательный вариант, а только лишь предварительный. "
        "Тема должна быть лаконичной, интересной для автора, практически реализуемой и обеспеченной источниками информации».",
        "Методическое требование к выбору темы:"
    )

    add_body(
        "Информатика, информационно-коммуникационные технологии (ИКТ) и программная инженерия (разработка программного обеспечения).",
        bold_prefix="1) С какой большой областью знаний или умений связана тема проекта? — "
    )
    
    add_body(
        "Прикладное программирование, архитектура кроссплатформенных приложений, веб-технологии (Frontend и бэкенд-мосты), работа с медиапотоками (Web Audio API), сетевое взаимодействие и адаптивный дизайн.",
        bold_prefix="2) Какому разделу он посвящён? — "
    )
    
    add_body(
        "Сегодня музыка сопровождает почти каждого ученика и студента во время учёбы, чтения или написания программного кода. "
        "Однако большинство коммерческих плееров (Яндекс Музыка, Spotify, VK Музыка) сильно перегружены: в них появилась постоянная навязчивая реклама, платные подписки, "
        "ленты рекомендаций, короткие видео и подкасты. Всё это отвлекает от концентрации на работе. "
        "Кроме того, в связи с региональными ограничениями и блокировками часть любимых треков пропадает из официальных каталогов. "
        "Поэтому возникла практическая необходимость создать собственный лёгкий, автономный и бесплатный аудиоплеер, который не требует подписок, "
        "умеет воспроизводить музыку из открытых источников и создаёт уютную атмосферу (Lo-Fi, дзэн, звуки дождя, частицы) без отвлекающих факторов.",
        bold_prefix="3) Почему данная тема представляется актуальной (современной, нужной)? — "
    )

    add_body(
        "Создан полноценный рабочий программный продукт, готовый к ежедневному использованию: приложение для компьютера (Windows) и мобильный APK-файл для смартфона (Android). "
        "Плеер умеет воспроизводить музыку, искать треки, импортировать плейлисты и создавать фоновые атмосферы.\n"
        "Исследованы методы разработки кроссплатформенных систем на базе единого стека (JavaScript/HTML5), технологии оптимизации мобильной производительности "
        "и способы прямого воспроизведения веб-медиапотоков без раздутых сторонних библиотек.",
        bold_prefix="4) В чём практическая и теоретическая значимость работы? —\n• Практическая: • Теоретическая: "
    )

    add_body(
        "Проект рассчитан на школьников, студентов, программистов и всех, кто работает за компьютером или телефоном и нуждается в спокойном музыкальном сопровождении "
        "для продуктивной концентрации или отдыха. Приложение работает автономно дома, в школе и в дороге.",
        bold_prefix="5) Кому может пригодиться эта работа, кто, когда и где её может использовать? — "
    )

    # ==================== SECTION 3: SIX P ====================
    add_h1("3. Структура проекта по модели «Шесть П»")
    
    table_p = doc.add_table(rows=7, cols=3)
    table_p.alignment = WD_TABLE_ALIGNMENT.CENTER
    table_p.autofit = False
    set_table_borders(table_p, color="CBD5E1", sz="6")
    
    p_headers = ["Элемент «П»", "Содержание в проекте MintPy", "Результат"]
    hdr_row = table_p.rows[0]
    col_w_p = [Inches(1.3), Inches(3.3), Inches(1.7)]
    
    for idx, text in enumerate(p_headers):
        cell = hdr_row.cells[idx]
        cell.width = col_w_p[idx]
        set_cell_background(cell, "E2E8F0")
        set_cell_margins(cell, top=100, bottom=100, left=100, right=100)
        p = cell.paragraphs[0]
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        r = p.add_run(text)
        r.bold = True
        r.font.size = Pt(10)
        r.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)

    six_p_data = [
        ("1. Проблема", "Существующие музыкальные сервисы перегружены коммерцией, алгоритмической лентой и рекламой, отвлекающей от учёбы и продуктивной работы.", "Формулировка ТЗ"),
        ("2. Планирование", "Анализ архитектурных решений, выбор связки Electron + Android WebView, декомпозиция разработки на функциональные модули.", "Календарный план"),
        ("3. Поиск информации", "Изучение стандартов Web Audio API, документации Innertube API, особенностей CSS-анимаций на мобильных GPU и упаковки APK.", "Аналитический обзор"),
        ("4. Продукт", "Разработка десктопного приложения для ПК и мобильного приложения для Android под единым интерфейсным стилем.", "Рабочий софт (.exe, .apk)"),
        ("5. Презентация", "Демонстрация работы плеера: воспроизведение музыки, вращение винила, переключение визуальных тем (Zen, Lo-Fi, Synthwave), импорт ссылок.", "Доклад и слайды"),
        ("6. Портфолио", "Оформление репозитория с открытым исходным кодом, паспорта проекта, пользовательской инструкции и файлов дистрибутивов.", "Проектная папка")
    ]

    for i, (p_item, p_desc, p_res) in enumerate(six_p_data, start=1):
        row = table_p.rows[i]
        
        # Col 0
        c0 = row.cells[0]
        c0.width = col_w_p[0]
        set_cell_background(c0, "F8FAFC")
        set_cell_margins(c0, top=80, bottom=80, left=100, right=100)
        p0 = c0.paragraphs[0]
        r0 = p0.add_run(p_item)
        r0.bold = True
        r0.font.size = Pt(10)
        
        # Col 1
        c1 = row.cells[1]
        c1.width = col_w_p[1]
        set_cell_margins(c1, top=80, bottom=80, left=100, right=100)
        p1 = c1.paragraphs[0]
        p1.paragraph_format.line_spacing = 1.05
        r1 = p1.add_run(p_desc)
        r1.font.size = Pt(9.5)
        
        # Col 2
        c2 = row.cells[2]
        c2.width = col_w_p[2]
        set_cell_margins(c2, top=80, bottom=80, left=100, right=100)
        p2 = c2.paragraphs[0]
        p2.paragraph_format.line_spacing = 1.05
        r2 = p2.add_run(p_res)
        r2.font.size = Pt(9.5)
        r2.font.color.rgb = RGBColor(0x25, 0x63, 0xEB)

    doc.add_paragraph().paragraph_format.space_after = Pt(4)

    # What the project launches block
    add_h2("Характер и направленность результата проекта:")
    add_body(
        "Создано законченное прикладное приложение с адаптивным пользовательским интерфейсом, локальной базой настроек и независимым аудиодвижком.",
        bold_prefix="• Конструирование → Создание объекта: "
    )
    add_body(
        "Изучены принципы построения кроссплатформенных приложений на веб-технологиях без применения тяжеловесных фреймворков; освоен механизм работы браузерных движков внутри мобильного контейнера.",
        bold_prefix="• Исследование → Новое знание: "
    )
    add_body(
        "Реализована эстетическая концепция «дзэн-плеера»: интерактивные частицы сакуры, динамическая подсветка, реалистичная анимация вращения виниловой пластинки с бликом света.",
        bold_prefix="• Искусство → Восприятие: "
    )

    # ==================== SECTION 4: GOALS & TASKS ====================
    add_h1("4. Цель, задачи и объект исследования")
    
    add_body(
        "Создать удобное, легковесное кроссплатформенное приложение для прослушивания музыки и концентрации на учёбе с уникальным атмосферным дизайном и поддержкой ПК и Android.",
        bold_prefix="Цель проекта: "
    )
    
    add_body("Для достижения поставленной цели необходимо решить следующие практические задачи:", bold_prefix="Задачи проекта: ")
    
    tasks = [
        "Провести сравнительный анализ существующих аудиоплееров и выделить ключевые требования к плееру для учёбы и отдыха;",
        "Спроектировать эргономичный и визуально приятный интерфейс (UI/UX) с поддержкой нескольких тем оформления (Zen, Lo-Fi, Synthwave, Ocean, Forest, Aurora);",
        "Реализовать аудиодвижок на базе HTML5 Audio и Web Audio API с поддержкой эквалайзера и нормализации звука;",
        "Разработать модуль прямого поиска и импорта треков и плейлистов из открытых источников (Яндекс Музыка, Spotify, YouTube Music);",
        "Создать мобильную версию приложения на базе Android WebView с оптимизацией потребления ресурсов и CSS-анимаций;",
        "Настроить процесс сборки автономного APK-файла и провести тестирование на реальных устройствах."
    ]
    for idx, t in enumerate(tasks, 1):
        p_t = doc.add_paragraph()
        p_t.paragraph_format.left_indent = Inches(0.4)
        p_t.paragraph_format.space_before = Pt(0)
        p_t.paragraph_format.space_after = Pt(2)
        p_t.paragraph_format.line_spacing = 1.15
        r_num = p_t.add_run(f"{idx}. ")
        r_num.bold = True
        p_t.add_run(t)

    add_body("Архитектура современных клиентских веб-приложений и мультимедийных сред.", bold_prefix="Объект исследования: ", space_after=2)
    add_body("Разработка кроссплатформенного мультимедийного плеера средствами HTML5, CSS3, JavaScript и Android SDK.", bold_prefix="Предмет исследования: ", space_after=2)
    add_body("Анализ аналогов, моделирование интерфейса, прототипирование, программная разработка, профилирование производительности и тестирование.", bold_prefix="Методы исследования: ", space_after=8)

    # ==================== SECTION 5: PLAN ====================
    add_h1("5. Календарный план и этапы жизненного цикла проекта")
    
    table_plan = doc.add_table(rows=6, cols=4)
    table_plan.alignment = WD_TABLE_ALIGNMENT.CENTER
    table_plan.autofit = False
    set_table_borders(table_plan, color="CBD5E1", sz="6")
    
    plan_headers = ["Этап", "Вид деятельности", "Содержание работы", "Сроки"]
    hdr_plan = table_plan.rows[0]
    col_w_plan = [Inches(1.1), Inches(1.5), Inches(2.7), Inches(1.0)]
    
    for idx, text in enumerate(plan_headers):
        cell = hdr_plan.cells[idx]
        cell.width = col_w_plan[idx]
        set_cell_background(cell, "E2E8F0")
        set_cell_margins(cell, top=80, bottom=80, left=80, right=80)
        p = cell.paragraphs[0]
        r = p.add_run(text)
        r.bold = True
        r.font.size = Pt(9.5)
        r.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)

    plan_rows = [
        ("1. Инициация", "Анализ и постановка задачи", "Формулировка темы, выявление проблемы, сбор требований, согласование темы с руководителем", "Сентябрь 2025"),
        ("2. Планирование", "Проектирование и макеты", "Выбор стека технологий, разработка макетов интерфейса и архитектурной схемы приложения", "Октябрь 2025"),
        ("3. Реализация (Ядро)", "Разработка аудиоплеера", "Написание JS-движка воспроизведения, создание системы плейлистов, очереди и эквалайзера", "Ноябрь – Декабрь 2025"),
        ("4. Реализация (UI)", "Атмосферный интерфейс и мобайл", "Верстка тем оформления, Canvas-частицы, адаптация под Android WebView, сборка APK", "Январь – Февраль 2026"),
        ("5. Завершение", "Тестирование и защита", "Отладка багов, нагрузочное тестирование, подготовка презентации и паспорта проекта", "Март – Апрель 2026")
    ]

    for i, (st, act, cont, time_str) in enumerate(plan_rows, start=1):
        row = table_plan.rows[i]
        
        c0 = row.cells[0]
        c0.width = col_w_plan[0]
        set_cell_background(c0, "F8FAFC")
        set_cell_margins(c0, top=60, bottom=60, left=80, right=80)
        p0 = c0.paragraphs[0]
        r0 = p0.add_run(st)
        r0.bold = True
        r0.font.size = Pt(9)
        
        c1 = row.cells[1]
        c1.width = col_w_plan[1]
        set_cell_margins(c1, top=60, bottom=60, left=80, right=80)
        p1 = c1.paragraphs[0]
        p1.paragraph_format.line_spacing = 1.05
        p1.add_run(act).font.size = Pt(9)
        
        c2 = row.cells[2]
        c2.width = col_w_plan[2]
        set_cell_margins(c2, top=60, bottom=60, left=80, right=80)
        p2 = c2.paragraphs[0]
        p2.paragraph_format.line_spacing = 1.05
        p2.add_run(cont).font.size = Pt(9)
        
        c3 = row.cells[3]
        c3.width = col_w_plan[3]
        set_cell_margins(c3, top=60, bottom=60, left=80, right=80)
        p3 = c3.paragraphs[0]
        p3.paragraph_format.line_spacing = 1.05
        r3 = p3.add_run(time_str)
        r3.font.size = Pt(8.5)
        r3.font.color.rgb = RGBColor(0x47, 0x55, 0x69)

    doc.add_paragraph().paragraph_format.space_after = Pt(4)

    # ==================== SECTION 6: PRACTICAL RESULTS ====================
    add_h1("6. Практическая реализация и архитектура MintPy")
    
    add_body(
        "Проект MintPy спроектирован по модульному принципу. Главная цель архитектуры — обеспечить мгновенный запуск и плавную работу интерфейса "
        "как на мощном настольном компьютере, так и на бюджетном смартфоне, не нагружая процессор и аккумулятор устройства.",
        bold_prefix="Архитектурный подход: "
    )

    add_body(
        "1) Модуль аудиодека: прямое воспроизведение аудиопотока через нативный HTML5 Audio элемент без искусственных задержек;\n"
        "2) Движок стилей и атмосфер: поддержка 6 уникальных тем (Zen, Lo-Fi, Synthwave, Ocean, Forest, Aurora) с динамической палитрой и переключением светлого/темного режима;\n"
        "3) Анимационный движок Canvas: лёгкая отрисовка частиц в реальном времени (падающие лепестки сакуры, поднимающийся пар кофе, мерцающие звёзды, светлячки);\n"
        "4) Модуль винилового проигрывателя: реалистичный виниловый диск с коническим световым градиентом, вращающийся во время воспроизведения трека;\n"
        "5) Модуль поиска и импорта: прямое подключение к открытым веб-эндпоинтам (YouTube, Spotify, Яндекс Музыка) для быстрого переноса треков в личные плейлисты пользователя;\n"
        "6) Автономное хранилище данных: история прослушивания, избранные треки и пользовательские плейлисты сохраняются локально и доступны без интернета.",
        bold_prefix="Ключевые функциональные блоки приложения:\n"
    )

    add_body(
        "Для мобильной версии был написан автономный легковесный пайплайн сборки на Python с использованием утилит Android SDK (aapt2, d8, apksigner). "
        "Это позволило отказаться от громоздкой среды Gradle и собирать готовый подписанный APK-файл размером всего около 15 МБ буквально за несколько секунд.",
        bold_prefix="Сборка мобильного дистрибутива: "
    )

    # ==================== SECTION 7: TEACHER SIGNATURE BLOCK ====================
    add_h1("7. Согласование темы проекта с руководителем")
    
    tbl_sign = doc.add_table(rows=1, cols=1)
    tbl_sign.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl_sign.autofit = False
    
    cell_s = tbl_sign.cell(0, 0)
    cell_s.width = Inches(6.3)
    set_cell_background(cell_s, "F8FAFC")
    set_cell_margins(cell_s, top=140, bottom=140, left=180, right=180)
    
    tc_pr_s = cell_s._tc.get_or_add_tcPr()
    border_s = parse_xml(
        f'<w:tcBorders {nsdecls("w")}>'
        f'  <w:top w:val="single" w:sz="12" w:space="0" w:color="2563EB"/>'
        f'  <w:left w:val="single" w:sz="12" w:space="0" w:color="2563EB"/>'
        f'  <w:bottom w:val="single" w:sz="12" w:space="0" w:color="2563EB"/>'
        f'  <w:right w:val="single" w:sz="12" w:space="0" w:color="2563EB"/>'
        f'</w:tcBorders>'
    )
    tc_pr_s.append(border_s)
    
    ps = cell_s.paragraphs[0]
    ps.paragraph_format.line_spacing = 1.3
    
    rs1 = ps.add_run("РЕШЕНИЕ РУКОВОДИТЕЛЯ ПРОЕКТА:\n")
    rs1.bold = True
    rs1.font.size = Pt(11)
    rs1.font.color.rgb = RGBColor(0x1E, 0x3A, 0x8A)
    
    rs2 = ps.add_run(
        "Тема индивидуального проекта «Разработка кроссплатформенного мультимедийного приложения \"MintPy\" "
        "с атмосферным интерфейсом и интеграцией веб-источников» рассмотрена и утверждена.\n\n"
        "Отметка о согласовании:  "
    )
    rs2.font.size = Pt(11)
    
    rs_ok = ps.add_run("СОГЛАСОВАНО\n\n")
    rs_ok.bold = True
    rs_ok.font.size = Pt(12)
    rs_ok.font.color.rgb = RGBColor(0x05, 0x96, 0x69)
    
    rs3 = ps.add_run(
        "Подпись руководителя проекта: _________________ / ________________________ /\n\n"
        "Дата согласования: «____» ________________ 2025 г.\n"
    )
    rs3.font.size = Pt(10.5)

    # Save document in both Cyrillic and Latin names for convenience
    out_dir = r"D:\mintpy"
    out_path_cyr = os.path.join(out_dir, "Паспорт_проекта_MintPy.docx")
    out_path_lat = os.path.join(out_dir, "MintPy_Project_Passport.docx")
    doc.save(out_path_cyr)
    doc.save(out_path_lat)
    print(f"Successfully generated:\n- {out_path_cyr}\n- {out_path_lat}")

if __name__ == "__main__":
    import sys
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    build_document()
