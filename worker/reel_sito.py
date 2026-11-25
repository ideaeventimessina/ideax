from PIL import Image, ImageDraw

CONTROLLI = ("menu", "contrasto", "contatti", "velocita", "link")


def schermata(controllo, font):
    image = Image.new("RGB", (720, 1280), "#102b2c")
    draw = ImageDraw.Draw(image)
    ink, paper, accent = "#173333", "#f5f1e7", "#bce6d0"

    def label(x, y, value, size=28, color=ink):
        draw.text((x, y), value, font=font(size), fill=color)

    def box(bounds, fill, radius=13):
        draw.rounded_rectangle(bounds, radius, fill=fill)

    label(54, 100, "Studio Oliva / Demo", 34, accent)
    box((37, 182, 683, 880), paper, 25)
    label(70, 215, "Studio Oliva", 39)
    draw.line((69, 289, 650, 289), fill="#a1b0a6", width=2)
    if controllo == "menu":
        for y in (224, 235, 246):
            draw.line((595, y, 632, y), fill=ink, width=4)
        label(72, 323, "Navigazione mobile", 26)
        for i, voce in enumerate(("Home", "Progetti", "Chi siamo", "Contatti")):
            y = 401 + i * 90
            box((70, y, 649, y + 70), accent if i == 1 else "#e7e9df")
            label(93, y + 17, voce, 29)
    elif controllo == "contrasto":
        label(72, 333, "Contrasto testo e sfondo", 30)
        for y, col, valore in ((432, "#949991", "2,4 : 1   ·   Da correggere"), (599, ink, "11,4 : 1   ·   Leggibile")):
            box((72, y, 649, y + 138), "#edece2")
            label(96, y + 14, "Esplora i progetti", 39, col)
            label(96, y + 78, valore, 26)
    elif controllo == "contatti":
        label(72, 322, "Contattaci", 39)
        for y, campo, valore in ((408, "Nome", "Visitatore di prova"), (523, "Messaggio", "Richiesta informazioni")):
            label(76, y, campo, 24)
            box((72, y + 41, 647, y + 99), "#e3e9df")
            label(90, y + 51, valore, 27)
        box((72, 657, 280, 718), ink)
        label(94, 670, "Invia", 29, paper)
        box((72, 753, 647, 815), accent)
        label(93, 768, "Messaggio ricevuto", 28)
    elif controllo == "velocita":
        label(72, 333, "Caricamento su rete mobile", 29)
        for y, testo, colore, larghezza in ((449, "Immagine originale   3,2 s", "#bd8558", 545), (621, "Immagine ottimizzata   1,1 s", "#84c29c", 187)):
            label(72, y, testo, 29)
            box((72, y + 54, 645, y + 87), "#e3e9df")
            box((72, y + 54, 72 + larghezza, y + 87), colore)
    elif controllo == "link":
        label(72, 333, "Verifica collegamenti", 32)
        for y, url, status, color in ((432, "/progetti", "200", accent), (531, "/galleria", "404", "#f0c6ac"), (630, "/contatti", "200", accent)):
            draw.line((72, y + 75, 647, y + 75), fill="#a1b0a6", width=2)
            label(72, y + 16, url, 31)
            box((511, y + 2, 641, y + 59), color)
            label(544, y + 12, status, 28)
        label(72, 759, "Correggi il link alla galleria", 26)
    else:
        raise ValueError("Controllo del sito sconosciuto")
    return image
