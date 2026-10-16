import type { SupportedLocale } from "@lurkloot/shared/models";

// Store artwork copy is kept separate from product UI messages.
export interface StoreArtworkCopy {
  tagline: string;
  stories: Record<"queue" | "games" | "kick" | "watchlist" | "extensions", {
    number: string; label: string; title: string; description: string; points: string[]; caption: string;
  }>;
  overview: { tagline: string; title: string; description: string; steps: [string, string][] };
  promo: { lines: string[]; steps: [string, string][] };
}

export const STORE_ARTWORK_COPY: Record<SupportedLocale, StoreArtworkCopy> = {
  "en": {
    "tagline": "LESS WATCHING. MORE REWARDS.",
    "stories": {
      "queue": {
        "number": "01",
        "label": "AUTOMATIC DROPS",
        "title": "Your drops.\nOn autopilot.",
        "description": "Pick what matters. Lurkloot finds a stream, tracks your progress, and claims your rewards.",
        "points": [
          "Twitch + Kick",
          "Automatic claiming",
          "Your account. Your control."
        ],
        "caption": "The queue, the stream, the next reward. All in one place."
      },
      "games": {
        "number": "02",
        "label": "YOUR WATCH ORDER",
        "title": "Your games.\nYour priorities.",
        "description": "Pin a campaign. Star a favourite game. Block the rest. Make the next reward one you actually want.",
        "points": [
          "Pin individual campaigns",
          "Put favourite games first",
          "Skip games you don't play"
        ],
        "caption": "Choose what gets your watch time."
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "Two platforms.\nOne workspace.",
        "description": "Keep an eye on your Kick rewards with the same clear controls you use for Twitch.",
        "points": [
          "Separate platform controls",
          "Live campaign progress",
          "Idle watchlists for the gaps"
        ],
        "caption": "Switch platforms. Keep the same routine."
      },
      "watchlist": {
        "number": "04",
        "label": "IDLE WATCHLIST",
        "title": "Keep your\nfavourites close.",
        "description": "Choose the channels you want to watch when no eligible drops are available. Keep a separate list for each platform.",
        "points": [
          "Your channels, in your order",
          "Up to 20 channels per platform",
          "Choose your watch-source priority"
        ],
        "caption": "A plan for the time between campaigns."
      },
      "extensions": {
        "number": "05",
        "label": "TWITCH EXTENSIONS",
        "title": "More ways\nto earn.",
        "description": "Lurkloot also supports rewards from selected Twitch extensions. Enable the support you want and set your watch order.",
        "points": [
          "Optional Twitch extension support",
          "Dedicated progress views",
          "One place to manage your sources"
        ],
        "caption": "Support for selected extensions. Enabled on your terms."
      }
    },
    "overview": {
      "tagline": "REWARDS, CONNECTED.",
      "title": "Beyond drops.",
      "description": "Bring supported Twitch extension rewards into the same workspace as your drops and idle watchlists.",
      "steps": [
        [
          "Enable optional support",
          "Choose which supported extensions to enable."
        ],
        [
          "Set the watch order",
          "Decide where extension rewards fit alongside drops and your watchlist."
        ],
        [
          "Follow your progress",
          "See reward progress and status in dedicated views."
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Automatic rewards.",
        "Supports selected Twitch extensions."
      ],
      "steps": [
        [
          "Drops on autopilot",
          "Find a stream. Track progress. Claim rewards."
        ],
        [
          "Twitch extensions, too",
          "Optional support for selected extension rewards."
        ],
        [
          "Your watch order",
          "Pin campaigns. Star games. Pick your channels."
        ]
      ]
    }
  },
  "es": {
    "tagline": "MENOS ESPERA. MÁS RECOMPENSAS.",
    "stories": {
      "queue": {
        "number": "01",
        "label": "DROPS AUTOMÁTICOS",
        "title": "Tus drops.\nEn automático.",
        "description": "Elige lo que te importa. Lurkloot busca una transmisión, sigue tu progreso y reclama tus recompensas.",
        "points": [
          "Twitch + Kick",
          "Reclamación automática",
          "Tu cuenta. Tú decides."
        ],
        "caption": "La cola, la transmisión y tu próxima recompensa. Todo junto."
      },
      "games": {
        "number": "02",
        "label": "TU ORDEN DE VISIONADO",
        "title": "Tus juegos.\nTus prioridades.",
        "description": "Fija una campaña. Marca un juego favorito. Bloquea el resto. Consigue las recompensas que de verdad quieres.",
        "points": [
          "Fija campañas individuales",
          "Prioriza tus juegos favoritos",
          "Omite los juegos que no juegas"
        ],
        "caption": "Decide a qué dedicas tu tiempo de visionado."
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "Dos plataformas.\nUn solo lugar.",
        "description": "Sigue tus recompensas de Kick con los mismos controles claros que usas para Twitch.",
        "points": [
          "Controles por plataforma",
          "Progreso de campañas en directo",
          "Listas para los ratos sin drops"
        ],
        "caption": "Cambia de plataforma. Mantén tu rutina."
      },
      "watchlist": {
        "number": "04",
        "label": "LISTA DE RESERVA",
        "title": "Tus favoritos.\nSiempre cerca.",
        "description": "Elige qué canales ver cuando no haya drops disponibles para ti. Mantén una lista distinta para cada plataforma.",
        "points": [
          "Tus canales, en tu orden",
          "Hasta 20 canales por plataforma",
          "Prioriza tus fuentes de visionado"
        ],
        "caption": "Un plan para el tiempo entre campañas."
      },
      "extensions": {
        "number": "05",
        "label": "EXTENSIONES DE TWITCH",
        "title": "Más formas\nde ganar.",
        "description": "Lurkloot también admite recompensas de algunas extensiones de Twitch. Activa las que quieras y define tu orden de visionado.",
        "points": [
          "Soporte opcional para extensiones",
          "Vistas de progreso específicas",
          "Gestiona tus fuentes en un lugar"
        ],
        "caption": "Extensiones seleccionadas. Tú decides cuáles activar."
      }
    },
    "overview": {
      "tagline": "RECOMPENSAS CONECTADAS.",
      "title": "Más allá de los drops.",
      "description": "Reúne las recompensas de extensiones de Twitch compatibles, tus drops y tus listas de canales en un solo lugar.",
      "steps": [
        [
          "Activa el soporte opcional",
          "Elige qué extensiones compatibles quieres activar."
        ],
        [
          "Define el orden de visionado",
          "Decide la prioridad de las extensiones, los drops y tu lista de canales."
        ],
        [
          "Sigue tu progreso",
          "Consulta el progreso y el estado de las recompensas en vistas específicas."
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Recompensas automáticas.",
        "Compatible con algunas extensiones de Twitch."
      ],
      "steps": [
        [
          "Drops en automático",
          "Busca una transmisión. Sigue el progreso. Reclama recompensas."
        ],
        [
          "También extensiones de Twitch",
          "Soporte opcional para recompensas de algunas extensiones."
        ],
        [
          "Tu orden de visionado",
          "Fija campañas. Marca juegos. Elige tus canales."
        ]
      ]
    }
  },
  "fr": {
    "tagline": "MOINS D’ATTENTE. PLUS DE RÉCOMPENSES.",
    "stories": {
      "queue": {
        "number": "01",
        "label": "DROPS AUTOMATIQUES",
        "title": "Vos drops.\nEn automatique.",
        "description": "Choisissez l’essentiel. Lurkloot trouve un stream, suit votre progression et récupère vos récompenses.",
        "points": [
          "Twitch + Kick",
          "Récupération automatique",
          "Votre compte. Vous décidez."
        ],
        "caption": "La file, le stream, la prochaine récompense. Tout est là."
      },
      "games": {
        "number": "02",
        "label": "VOTRE ORDRE DE VISIONNAGE",
        "title": "Vos jeux.\nVos priorités.",
        "description": "Épinglez une campagne. Ajoutez un jeu aux favoris. Bloquez les autres. Obtenez les récompenses qui vous plaisent.",
        "points": [
          "Épinglez des campagnes",
          "Priorité à vos jeux favoris",
          "Ignorez les jeux sans intérêt"
        ],
        "caption": "Décidez où va votre temps de visionnage."
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "Deux plateformes.\nUn seul espace.",
        "description": "Suivez vos récompenses Kick avec les mêmes commandes claires que sur Twitch.",
        "points": [
          "Commandes par plateforme",
          "Progression en direct",
          "Listes de chaînes entre les drops"
        ],
        "caption": "Changez de plateforme. Gardez vos habitudes."
      },
      "watchlist": {
        "number": "04",
        "label": "LISTE D’ATTENTE",
        "title": "Vos favoris.\nToujours proches.",
        "description": "Choisissez les chaînes à regarder quand aucun drop éligible n’est disponible. Gardez une liste pour chaque plateforme.",
        "points": [
          "Vos chaînes, dans votre ordre",
          "Jusqu’à 20 chaînes par plateforme",
          "Classez vos sources de visionnage"
        ],
        "caption": "Un programme entre deux campagnes."
      },
      "extensions": {
        "number": "05",
        "label": "EXTENSIONS TWITCH",
        "title": "Encore plus\nde récompenses.",
        "description": "Lurkloot prend aussi en charge les récompenses de certaines extensions Twitch. Activez celles de votre choix et fixez les priorités.",
        "points": [
          "Prise en charge facultative",
          "Vues de progression dédiées",
          "Vos sources réunies au même endroit"
        ],
        "caption": "Certaines extensions. À activer selon vos envies."
      }
    },
    "overview": {
      "tagline": "VOS RÉCOMPENSES RÉUNIES.",
      "title": "Au-delà des drops.",
      "description": "Retrouvez les récompenses des extensions Twitch compatibles, vos drops et vos listes de chaînes dans un même espace.",
      "steps": [
        [
          "Activez la prise en charge",
          "Choisissez les extensions compatibles à activer."
        ],
        [
          "Fixez l’ordre de visionnage",
          "Classez les récompenses d’extensions, les drops et votre liste de chaînes."
        ],
        [
          "Suivez votre progression",
          "Consultez la progression et l’état des récompenses dans des vues dédiées."
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Récompenses automatiques.",
        "Compatible avec certaines extensions Twitch."
      ],
      "steps": [
        [
          "Des drops en automatique",
          "Trouvez un stream. Suivez la progression. Récupérez vos gains."
        ],
        [
          "Les extensions Twitch aussi",
          "Prise en charge facultative de certaines récompenses d’extensions."
        ],
        [
          "Votre ordre de visionnage",
          "Épinglez des campagnes. Ajoutez des favoris. Choisissez vos chaînes."
        ]
      ]
    }
  },
  "it": {
    "tagline": "MENO ATTESA. PIÙ RICOMPENSE.",
    "stories": {
      "queue": {
        "number": "01",
        "label": "DROP AUTOMATICI",
        "title": "I tuoi drop.\nIn automatico.",
        "description": "Scegli ciò che conta. Lurkloot trova uno stream, segue i progressi e riscatta le tue ricompense.",
        "points": [
          "Twitch + Kick",
          "Riscatto automatico",
          "Il tuo account. Decidi tu."
        ],
        "caption": "La coda, lo stream, la prossima ricompensa. Tutto qui."
      },
      "games": {
        "number": "02",
        "label": "IL TUO ORDINE DI VISIONE",
        "title": "I tuoi giochi.\nLe tue priorità.",
        "description": "Fissa una campagna. Aggiungi un gioco ai preferiti. Blocca gli altri. Ottieni le ricompense che vuoi davvero.",
        "points": [
          "Fissa singole campagne",
          "Dai priorità ai giochi preferiti",
          "Salta i giochi che non ti interessano"
        ],
        "caption": "Scegli come usare il tempo di visione."
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "Due piattaforme.\nUn unico spazio.",
        "description": "Segui le ricompense di Kick con gli stessi comandi chiari che usi su Twitch.",
        "points": [
          "Comandi separati per piattaforma",
          "Progressi delle campagne in diretta",
          "Liste di canali tra un drop e l’altro"
        ],
        "caption": "Cambia piattaforma. Mantieni le tue abitudini."
      },
      "watchlist": {
        "number": "04",
        "label": "LISTA DI RISERVA",
        "title": "I tuoi preferiti.\nSempre vicini.",
        "description": "Scegli i canali da guardare quando non ci sono drop idonei. Mantieni una lista separata per ogni piattaforma.",
        "points": [
          "I tuoi canali, nel tuo ordine",
          "Fino a 20 canali per piattaforma",
          "Dai priorità alle fonti di visione"
        ],
        "caption": "Un piano tra una campagna e l’altra."
      },
      "extensions": {
        "number": "05",
        "label": "ESTENSIONI TWITCH",
        "title": "Più modi\nper guadagnare.",
        "description": "Lurkloot supporta anche le ricompense di alcune estensioni Twitch. Attiva quelle che vuoi e imposta l’ordine di visione.",
        "points": [
          "Supporto facoltativo alle estensioni",
          "Viste dedicate ai progressi",
          "Gestisci le fonti in un unico posto"
        ],
        "caption": "Estensioni selezionate. Scegli tu cosa attivare."
      }
    },
    "overview": {
      "tagline": "RICOMPENSE CONNESSE.",
      "title": "Oltre i drop.",
      "description": "Riunisci le ricompense delle estensioni Twitch supportate, i drop e le liste di canali in un unico spazio.",
      "steps": [
        [
          "Attiva il supporto facoltativo",
          "Scegli quali estensioni supportate attivare."
        ],
        [
          "Imposta l’ordine di visione",
          "Decidi la priorità delle estensioni rispetto ai drop e alla lista di canali."
        ],
        [
          "Segui i tuoi progressi",
          "Controlla progressi e stato delle ricompense nelle viste dedicate."
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Ricompense automatiche.",
        "Supporta alcune estensioni Twitch."
      ],
      "steps": [
        [
          "Drop in automatico",
          "Trova uno stream. Segui i progressi. Riscatta le ricompense."
        ],
        [
          "Anche le estensioni Twitch",
          "Supporto facoltativo alle ricompense di alcune estensioni."
        ],
        [
          "Il tuo ordine di visione",
          "Fissa campagne. Scegli giochi preferiti e canali."
        ]
      ]
    }
  },
  "de": {
    "tagline": "WENIGER WARTEN. MEHR BELOHNUNGEN.",
    "stories": {
      "queue": {
        "number": "01",
        "label": "AUTOMATISCHE DROPS",
        "title": "Deine Drops.\nGanz automatisch.",
        "description": "Wähle, was dir wichtig ist. Lurkloot findet einen Stream, verfolgt den Fortschritt und holt deine Belohnungen ab.",
        "points": [
          "Twitch + Kick",
          "Automatisch abholen",
          "Dein Konto. Deine Kontrolle."
        ],
        "caption": "Warteschlange, Stream und nächste Belohnung. Alles im Blick."
      },
      "games": {
        "number": "02",
        "label": "DEINE REIHENFOLGE",
        "title": "Deine Spiele.\nDeine Prioritäten.",
        "description": "Hefte eine Kampagne an. Markiere Lieblingsspiele. Blockiere den Rest. Sichere dir Belohnungen, die du wirklich willst.",
        "points": [
          "Einzelne Kampagnen anpinnen",
          "Lieblingsspiele zuerst",
          "Uninteressante Spiele überspringen"
        ],
        "caption": "Entscheide, wofür du zuschaust."
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "Zwei Plattformen.\nEin Ort.",
        "description": "Behalte deine Kick-Belohnungen mit den gleichen übersichtlichen Bedienelementen wie bei Twitch im Blick.",
        "points": [
          "Getrennte Plattformsteuerung",
          "Kampagnenfortschritt in Echtzeit",
          "Kanallisten für die Pausen"
        ],
        "caption": "Plattform wechseln. Gewohnte Abläufe behalten."
      },
      "watchlist": {
        "number": "04",
        "label": "ERSATZLISTE",
        "title": "Deine Favoriten.\nImmer dabei.",
        "description": "Wähle Kanäle für Zeiten ohne verfügbare Drops. Führe für jede Plattform eine eigene Liste.",
        "points": [
          "Deine Kanäle, deine Reihenfolge",
          "Bis zu 20 Kanäle pro Plattform",
          "Priorität der Quellen festlegen"
        ],
        "caption": "Ein Plan für die Zeit zwischen Kampagnen."
      },
      "extensions": {
        "number": "05",
        "label": "TWITCH-ERWEITERUNGEN",
        "title": "Mehr Wege\nzu Belohnungen.",
        "description": "Lurkloot unterstützt auch Belohnungen ausgewählter Twitch-Erweiterungen. Aktiviere die gewünschten Quellen und lege ihre Reihenfolge fest.",
        "points": [
          "Optionale Erweiterungsunterstützung",
          "Eigene Fortschrittsansichten",
          "Alle Quellen an einem Ort"
        ],
        "caption": "Ausgewählte Erweiterungen. Du entscheidest, was aktiv ist."
      }
    },
    "overview": {
      "tagline": "BELOHNUNGEN VEREINT.",
      "title": "Mehr als Drops.",
      "description": "Verwalte Belohnungen unterstützter Twitch-Erweiterungen, Drops und Kanallisten im selben Arbeitsbereich.",
      "steps": [
        [
          "Optionale Unterstützung aktivieren",
          "Wähle, welche unterstützten Erweiterungen du aktivieren möchtest."
        ],
        [
          "Reihenfolge festlegen",
          "Ordne Erweiterungsbelohnungen, Drops und deine Kanalliste nach Priorität."
        ],
        [
          "Fortschritt verfolgen",
          "Sieh Fortschritt und Status der Belohnungen in eigenen Ansichten."
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Automatische Belohnungen.",
        "Unterstützt ausgewählte Twitch-Erweiterungen."
      ],
      "steps": [
        [
          "Drops ganz automatisch",
          "Stream finden. Fortschritt verfolgen. Belohnungen abholen."
        ],
        [
          "Auch Twitch-Erweiterungen",
          "Optionale Unterstützung ausgewählter Erweiterungsbelohnungen."
        ],
        [
          "Deine Reihenfolge",
          "Kampagnen anpinnen. Spiele favorisieren. Kanäle wählen."
        ]
      ]
    }
  },
  "pt_BR": {
    "tagline": "MENOS ESPERA. MAIS RECOMPENSAS.",
    "stories": {
      "queue": {
        "number": "01",
        "label": "DROPS AUTOMÁTICOS",
        "title": "Seus drops.\nNo automático.",
        "description": "Escolha o que importa. O Lurkloot encontra uma transmissão, acompanha o progresso e resgata suas recompensas.",
        "points": [
          "Twitch + Kick",
          "Resgate automático",
          "Sua conta. Você no controle."
        ],
        "caption": "A fila, a transmissão e a próxima recompensa. Tudo junto."
      },
      "games": {
        "number": "02",
        "label": "SUA ORDEM DE EXIBIÇÃO",
        "title": "Seus jogos.\nSuas prioridades.",
        "description": "Fixe uma campanha. Favorite um jogo. Bloqueie o resto. Conquiste as recompensas que você realmente quer.",
        "points": [
          "Fixe campanhas individuais",
          "Priorize seus jogos favoritos",
          "Ignore jogos que você não joga"
        ],
        "caption": "Escolha como usar seu tempo assistindo."
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "Duas plataformas.\nUm só lugar.",
        "description": "Acompanhe suas recompensas da Kick com os mesmos controles simples que você usa na Twitch.",
        "points": [
          "Controles por plataforma",
          "Progresso das campanhas ao vivo",
          "Listas de canais entre os drops"
        ],
        "caption": "Mude de plataforma. Mantenha sua rotina."
      },
      "watchlist": {
        "number": "04",
        "label": "LISTA DE RESERVA",
        "title": "Seus favoritos.\nSempre por perto.",
        "description": "Escolha os canais para assistir quando não houver drops elegíveis. Mantenha uma lista separada para cada plataforma.",
        "points": [
          "Seus canais, na sua ordem",
          "Até 20 canais por plataforma",
          "Defina a prioridade das fontes"
        ],
        "caption": "Um plano para o intervalo entre campanhas."
      },
      "extensions": {
        "number": "05",
        "label": "EXTENSÕES DA TWITCH",
        "title": "Mais formas\nde ganhar.",
        "description": "O Lurkloot também oferece suporte a recompensas de algumas extensões da Twitch. Ative as que quiser e defina a ordem de exibição.",
        "points": [
          "Suporte opcional a extensões",
          "Telas de progresso dedicadas",
          "Gerencie suas fontes em um só lugar"
        ],
        "caption": "Extensões selecionadas. Você decide o que ativar."
      }
    },
    "overview": {
      "tagline": "RECOMPENSAS CONECTADAS.",
      "title": "Além dos drops.",
      "description": "Reúna recompensas de extensões compatíveis da Twitch, drops e listas de canais no mesmo espaço.",
      "steps": [
        [
          "Ative o suporte opcional",
          "Escolha quais extensões compatíveis deseja ativar."
        ],
        [
          "Defina a ordem de exibição",
          "Escolha a prioridade das extensões, dos drops e da sua lista de canais."
        ],
        [
          "Acompanhe seu progresso",
          "Veja o progresso e o status das recompensas em telas dedicadas."
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Recompensas automáticas.",
        "Suporte a algumas extensões da Twitch."
      ],
      "steps": [
        [
          "Drops no automático",
          "Encontre uma transmissão. Acompanhe o progresso. Resgate recompensas."
        ],
        [
          "Extensões da Twitch também",
          "Suporte opcional a recompensas de algumas extensões."
        ],
        [
          "Sua ordem de exibição",
          "Fixe campanhas. Favorite jogos. Escolha seus canais."
        ]
      ]
    }
  },
  "tr": {
    "tagline": "DAHA AZ BEKLE. DAHA ÇOK ÖDÜL.",
    "stories": {
      "queue": {
        "number": "01",
        "label": "OTOMATİK DROP’LAR",
        "title": "Drop’ların.\nOtomatik pilotta.",
        "description": "Senin için önemli olanı seç. Lurkloot bir yayın bulur, ilerlemeyi takip eder ve ödüllerini alır.",
        "points": [
          "Twitch + Kick",
          "Otomatik ödül alma",
          "Hesabın senin. Kontrol sende."
        ],
        "caption": "Sıra, yayın ve sıradaki ödül. Hepsi bir arada."
      },
      "games": {
        "number": "02",
        "label": "İZLEME SIRAN",
        "title": "Oyunların.\nÖnceliklerin.",
        "description": "Bir kampanyayı sabitle. Sevdiğin oyunu favorile. Diğerlerini engelle. Gerçekten istediğin ödülleri kazan.",
        "points": [
          "Kampanyaları tek tek sabitle",
          "Favori oyunlarına öncelik ver",
          "Oynamadığın oyunları atla"
        ],
        "caption": "İzleme süreni neye ayıracağını seç."
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "İki platform.\nTek alan.",
        "description": "Kick ödüllerini Twitch’te kullandığın aynı anlaşılır kontrollerle takip et.",
        "points": [
          "Her platform için ayrı kontroller",
          "Canlı kampanya ilerlemesi",
          "Drop aralarında kanal listeleri"
        ],
        "caption": "Platform değiştir. Düzenin aynı kalsın."
      },
      "watchlist": {
        "number": "04",
        "label": "YEDEK İZLEME LİSTESİ",
        "title": "Favorilerin.\nHep yanında.",
        "description": "Uygun drop olmadığında izlemek istediğin kanalları seç. Her platform için ayrı bir liste tut.",
        "points": [
          "Kanalların, senin sıralaman",
          "Platform başına en fazla 20 kanal",
          "İzleme kaynağı önceliğini seç"
        ],
        "caption": "Kampanyalar arasındaki zaman için bir plan."
      },
      "extensions": {
        "number": "05",
        "label": "TWITCH UZANTILARI",
        "title": "Ödül kazanmanın\ndaha çok yolu.",
        "description": "Lurkloot, seçili Twitch uzantılarının ödüllerini de destekler. İstediğin desteği aç ve izleme sırasını belirle.",
        "points": [
          "İsteğe bağlı uzantı desteği",
          "Özel ilerleme görünümleri",
          "Kaynaklarını tek yerden yönet"
        ],
        "caption": "Seçili uzantılar. Hangilerinin açık olacağına sen karar ver."
      }
    },
    "overview": {
      "tagline": "ÖDÜLLER BİR ARADA.",
      "title": "Drop’ların ötesinde.",
      "description": "Desteklenen Twitch uzantılarının ödüllerini, drop’larını ve yedek izleme listelerini aynı alanda yönet.",
      "steps": [
        [
          "İsteğe bağlı desteği aç",
          "Desteklenen uzantılardan hangilerini açacağını seç."
        ],
        [
          "İzleme sırasını belirle",
          "Uzantı ödüllerinin, drop’ların ve izleme listenin önceliğini belirle."
        ],
        [
          "İlerlemeni takip et",
          "Ödül ilerlemesini ve durumunu özel görünümlerde izle."
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Otomatik ödüller.",
        "Seçili Twitch uzantılarını destekler."
      ],
      "steps": [
        [
          "Drop’lar otomatik pilotta",
          "Bir yayın bul. İlerlemeyi takip et. Ödülleri al."
        ],
        [
          "Twitch uzantıları da var",
          "Seçili uzantı ödülleri için isteğe bağlı destek."
        ],
        [
          "İzleme sıran",
          "Kampanyaları sabitle. Oyunları favorile. Kanallarını seç."
        ]
      ]
    }
  },
  "ru": {
    "tagline": "МЕНЬШЕ ОЖИДАНИЯ. БОЛЬШЕ НАГРАД.",
    "stories": {
      "queue": {
        "number": "01",
        "label": "АВТОМАТИЧЕСКИЕ ДРОПЫ",
        "title": "Ваши дропы.\nНа автопилоте.",
        "description": "Выберите главное. Lurkloot найдёт трансляцию, отследит прогресс и заберёт награды.",
        "points": [
          "Twitch + Kick",
          "Автоматическое получение",
          "Ваш аккаунт под вашим контролем."
        ],
        "caption": "Очередь, трансляция и следующая награда. Всё рядом."
      },
      "games": {
        "number": "02",
        "label": "ПОРЯДОК ПРОСМОТРА",
        "title": "Ваши игры.\nВаши приоритеты.",
        "description": "Закрепите кампанию. Добавьте игру в избранное. Заблокируйте остальные. Получайте нужные вам награды.",
        "points": [
          "Закрепляйте отдельные кампании",
          "Любимые игры — в первую очередь",
          "Пропускайте ненужные игры"
        ],
        "caption": "Решайте, на что тратить время просмотра."
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "Две платформы.\nОдно место.",
        "description": "Следите за наградами Kick с теми же понятными элементами управления, что и на Twitch.",
        "points": [
          "Отдельные настройки платформ",
          "Прогресс кампаний в реальном времени",
          "Списки каналов между дропами"
        ],
        "caption": "Меняйте платформу. Сохраняйте привычный порядок."
      },
      "watchlist": {
        "number": "04",
        "label": "РЕЗЕРВНЫЙ СПИСОК",
        "title": "Любимые каналы.\nВсегда рядом.",
        "description": "Выберите каналы для просмотра, когда нет доступных дропов. Создайте отдельный список для каждой платформы.",
        "points": [
          "Ваши каналы, ваш порядок",
          "До 20 каналов на платформу",
          "Настройте приоритет источников"
        ],
        "caption": "План на время между кампаниями."
      },
      "extensions": {
        "number": "05",
        "label": "РАСШИРЕНИЯ TWITCH",
        "title": "Больше способов\nполучать награды.",
        "description": "Lurkloot также поддерживает награды некоторых расширений Twitch. Включите нужные и задайте порядок просмотра.",
        "points": [
          "Поддержка расширений по желанию",
          "Отдельные экраны прогресса",
          "Все источники в одном месте"
        ],
        "caption": "Выбранные расширения. Вы решаете, что включить."
      }
    },
    "overview": {
      "tagline": "НАГРАДЫ ВМЕСТЕ.",
      "title": "Больше, чем дропы.",
      "description": "Управляйте наградами поддерживаемых расширений Twitch, дропами и списками каналов в одном месте.",
      "steps": [
        [
          "Включите поддержку расширений",
          "Выберите, какие из поддерживаемых расширений включить."
        ],
        [
          "Задайте порядок просмотра",
          "Определите приоритет наград расширений, дропов и списка каналов."
        ],
        [
          "Следите за прогрессом",
          "Проверяйте прогресс и состояние наград на отдельных экранах."
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Награды автоматически.",
        "Поддержка некоторых расширений Twitch."
      ],
      "steps": [
        [
          "Дропы на автопилоте",
          "Найдите трансляцию. Следите за прогрессом. Забирайте награды."
        ],
        [
          "И расширения Twitch",
          "Поддержка наград некоторых расширений по желанию."
        ],
        [
          "Ваш порядок просмотра",
          "Закрепляйте кампании. Выбирайте игры и каналы."
        ]
      ]
    }
  },
  "zh_CN": {
    "tagline": "少些等待，多些奖励。",
    "stories": {
      "queue": {
        "number": "01",
        "label": "自动获取掉宝",
        "title": "你的掉宝。\n自动搞定。",
        "description": "选择你在意的奖励。Lurkloot 会寻找直播、跟踪进度，并领取奖励。",
        "points": [
          "Twitch + Kick",
          "自动领取奖励",
          "你的账号，由你掌控。"
        ],
        "caption": "队列、直播、下一个奖励，尽在一处。"
      },
      "games": {
        "number": "02",
        "label": "你的观看顺序",
        "title": "你的游戏。\n你的优先级。",
        "description": "置顶活动，收藏喜爱的游戏，屏蔽其他游戏。让下一个奖励正是你想要的。",
        "points": [
          "单独置顶活动",
          "优先观看收藏的游戏",
          "跳过不玩的游戏"
        ],
        "caption": "决定把观看时间花在哪里。"
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "两个平台。\n一个工作区。",
        "description": "用与 Twitch 一样清晰的操作方式，随时查看 Kick 奖励。",
        "points": [
          "平台独立控制",
          "实时活动进度",
          "无掉宝时观看频道列表"
        ],
        "caption": "切换平台，操作依旧熟悉。"
      },
      "watchlist": {
        "number": "04",
        "label": "空闲观看列表",
        "title": "喜爱的频道。\n随时相伴。",
        "description": "没有符合条件的掉宝时，观看你选择的频道。每个平台都能设置独立列表。",
        "points": [
          "你的频道，你的顺序",
          "每个平台最多 20 个频道",
          "设置观看来源优先级"
        ],
        "caption": "活动间歇，也有观看计划。"
      },
      "extensions": {
        "number": "05",
        "label": "TWITCH 扩展",
        "title": "更多方式，\n更多奖励。",
        "description": "Lurkloot 也支持部分 Twitch 扩展的奖励。按需启用支持，并设置观看顺序。",
        "points": [
          "可选的 Twitch 扩展支持",
          "专属进度视图",
          "集中管理观看来源"
        ],
        "caption": "支持部分扩展，是否启用由你决定。"
      }
    },
    "overview": {
      "tagline": "奖励汇聚一处。",
      "title": "不止掉宝。",
      "description": "将受支持的 Twitch 扩展奖励、掉宝和空闲观看列表，集中到同一个工作区。",
      "steps": [
        [
          "按需启用支持",
          "选择要启用哪些受支持的扩展。"
        ],
        [
          "设置观看顺序",
          "决定扩展奖励、掉宝和观看列表的优先级。"
        ],
        [
          "跟踪奖励进度",
          "在专属视图中查看奖励进度与状态。"
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick。自动获取奖励。",
        "支持部分 Twitch 扩展。"
      ],
      "steps": [
        [
          "掉宝自动搞定",
          "寻找直播，跟踪进度，领取奖励。"
        ],
        [
          "也支持 Twitch 扩展",
          "按需启用部分扩展奖励的支持。"
        ],
        [
          "你的观看顺序",
          "置顶活动，收藏游戏，选择频道。"
        ]
      ]
    }
  },
  "hi": {
    "tagline": "कम इंतज़ार। ज़्यादा इनाम।",
    "stories": {
      "queue": {
        "number": "01",
        "label": "अपने-आप ड्रॉप्स",
        "title": "आपके ड्रॉप्स।\nअपने-आप।",
        "description": "जो ज़रूरी है, उसे चुनें। Lurkloot स्ट्रीम ढूँढता है, प्रगति देखता है और आपके इनाम क्लेम करता है।",
        "points": [
          "Twitch + Kick",
          "अपने-आप इनाम क्लेम",
          "आपका खाता। आपका नियंत्रण।"
        ],
        "caption": "कतार, स्ट्रीम और अगला इनाम। सब एक जगह।"
      },
      "games": {
        "number": "02",
        "label": "आपका देखने का क्रम",
        "title": "आपके गेम।\nआपकी प्राथमिकताएँ।",
        "description": "कैंपेन पिन करें। पसंदीदा गेम चुनें। बाकी ब्लॉक करें। अगला इनाम वही हो जो आप चाहते हैं।",
        "points": [
          "अलग-अलग कैंपेन पिन करें",
          "पसंदीदा गेम को पहले रखें",
          "जो गेम नहीं खेलते, उन्हें छोड़ें"
        ],
        "caption": "तय करें कि देखने का समय कहाँ लगे।"
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "दो प्लेटफ़ॉर्म।\nएक जगह।",
        "description": "Twitch जैसे ही आसान नियंत्रणों से Kick के इनामों पर भी नज़र रखें।",
        "points": [
          "हर प्लेटफ़ॉर्म के अलग नियंत्रण",
          "कैंपेन की लाइव प्रगति",
          "ड्रॉप्स के बीच चैनलों की सूची"
        ],
        "caption": "प्लेटफ़ॉर्म बदलें। तरीका वही रखें।"
      },
      "watchlist": {
        "number": "04",
        "label": "आइडल वॉचलिस्ट",
        "title": "पसंदीदा चैनल।\nहमेशा पास।",
        "description": "जब कोई योग्य ड्रॉप उपलब्ध न हो, तब देखने के लिए चैनल चुनें। हर प्लेटफ़ॉर्म के लिए अलग सूची रखें।",
        "points": [
          "आपके चैनल, आपका क्रम",
          "हर प्लेटफ़ॉर्म पर 20 चैनल तक",
          "देखने के स्रोतों की प्राथमिकता चुनें"
        ],
        "caption": "कैंपेन के बीच के समय के लिए एक योजना।"
      },
      "extensions": {
        "number": "05",
        "label": "TWITCH एक्सटेंशन",
        "title": "इनाम पाने के\nऔर भी तरीके।",
        "description": "Lurkloot चुनिंदा Twitch एक्सटेंशन के इनामों को भी सपोर्ट करता है। अपनी पसंद का सपोर्ट चालू करें और देखने का क्रम तय करें।",
        "points": [
          "वैकल्पिक एक्सटेंशन सपोर्ट",
          "प्रगति के लिए अलग स्क्रीन",
          "सभी स्रोत एक जगह सँभालें"
        ],
        "caption": "चुनिंदा एक्सटेंशन। चालू करना आपकी मर्ज़ी।"
      }
    },
    "overview": {
      "tagline": "इनाम एक साथ।",
      "title": "ड्रॉप्स से आगे।",
      "description": "सपोर्ट वाले Twitch एक्सटेंशन के इनाम, ड्रॉप्स और आइडल वॉचलिस्ट एक ही जगह सँभालें।",
      "steps": [
        [
          "वैकल्पिक सपोर्ट चालू करें",
          "चुनें कि कौन-से सपोर्ट वाले एक्सटेंशन चालू करने हैं।"
        ],
        [
          "देखने का क्रम तय करें",
          "एक्सटेंशन के इनाम, ड्रॉप्स और वॉचलिस्ट की प्राथमिकता तय करें।"
        ],
        [
          "अपनी प्रगति देखें",
          "अलग स्क्रीन पर इनामों की प्रगति और स्थिति देखें।"
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick। अपने-आप इनाम।",
        "चुनिंदा Twitch एक्सटेंशन का सपोर्ट।"
      ],
      "steps": [
        [
          "ड्रॉप्स अपने-आप",
          "स्ट्रीम ढूँढें। प्रगति देखें। इनाम क्लेम करें।"
        ],
        [
          "Twitch एक्सटेंशन भी",
          "चुनिंदा एक्सटेंशन के इनामों के लिए वैकल्पिक सपोर्ट।"
        ],
        [
          "आपका देखने का क्रम",
          "कैंपेन पिन करें। पसंदीदा गेम और चैनल चुनें।"
        ]
      ]
    }
  },
  "ar": {
    "tagline": "انتظار أقل. مكافآت أكثر.",
    "stories": {
      "queue": {
        "number": "01",
        "label": "دروب تلقائية",
        "title": "الدروب الخاصة بك.\nتلقائيًا.",
        "description": "اختر ما يهمك. يعثر Lurkloot على بث، ويتابع تقدمك، ويطالب بمكافآتك.",
        "points": [
          "Twitch + Kick",
          "مطالبة تلقائية بالمكافآت",
          "حسابك. أنت المتحكم."
        ],
        "caption": "قائمة الانتظار والبث والمكافأة التالية. كل ذلك في مكان واحد."
      },
      "games": {
        "number": "02",
        "label": "ترتيب المشاهدة",
        "title": "ألعابك.\nأولوياتك.",
        "description": "ثبّت حملة. أضف لعبة إلى المفضلة. احظر الباقي. اجعل مكافأتك التالية شيئًا تريده حقًا.",
        "points": [
          "تثبيت حملات محددة",
          "الأولوية لألعابك المفضلة",
          "تجاوز الألعاب التي لا تلعبها"
        ],
        "caption": "اختر ما يستحق وقت مشاهدتك."
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "منصتان.\nمساحة واحدة.",
        "description": "تابع مكافآت Kick بنفس عناصر التحكم الواضحة التي تستخدمها مع Twitch.",
        "points": [
          "تحكم مستقل لكل منصة",
          "تقدم الحملات مباشرة",
          "قوائم قنوات بين الدروب"
        ],
        "caption": "بدّل المنصة. واحتفظ بطريقتك المعتادة."
      },
      "watchlist": {
        "number": "04",
        "label": "قائمة المشاهدة البديلة",
        "title": "قنواتك المفضلة.\nدائمًا بقربك.",
        "description": "اختر القنوات التي تريد مشاهدتها عند عدم توفر دروب مؤهلة. احتفظ بقائمة مستقلة لكل منصة.",
        "points": [
          "قنواتك، بترتيبك",
          "حتى 20 قناة لكل منصة",
          "اختر أولوية مصادر المشاهدة"
        ],
        "caption": "خطة للوقت بين الحملات."
      },
      "extensions": {
        "number": "05",
        "label": "إضافات TWITCH",
        "title": "طرق أكثر\nلكسب المكافآت.",
        "description": "يدعم Lurkloot أيضًا مكافآت إضافات مختارة على Twitch. فعّل الدعم الذي تريده وحدد ترتيب المشاهدة.",
        "points": [
          "دعم اختياري لإضافات Twitch",
          "واجهات مخصصة للتقدم",
          "إدارة مصادرك من مكان واحد"
        ],
        "caption": "إضافات مختارة. وأنت تقرر ما تفعّله."
      }
    },
    "overview": {
      "tagline": "مكافآتك في مكان واحد.",
      "title": "أكثر من مجرد دروب.",
      "description": "اجمع مكافآت إضافات Twitch المدعومة مع الدروب وقوائم المشاهدة البديلة في مساحة واحدة.",
      "steps": [
        [
          "فعّل الدعم الاختياري",
          "اختر الإضافات المدعومة التي تريد تفعيلها."
        ],
        [
          "حدد ترتيب المشاهدة",
          "رتّب أولوية مكافآت الإضافات والدروب وقائمة المشاهدة."
        ],
        [
          "تابع تقدمك",
          "اطّلع على تقدم المكافآت وحالتها في واجهات مخصصة."
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. مكافآت تلقائية.",
        "يدعم إضافات مختارة على Twitch."
      ],
      "steps": [
        [
          "دروب تلقائية",
          "اعثر على بث. تابع التقدم. طالب بالمكافآت."
        ],
        [
          "وإضافات Twitch أيضًا",
          "دعم اختياري لمكافآت إضافات مختارة."
        ],
        [
          "ترتيب المشاهدة الخاص بك",
          "ثبّت الحملات. اختر ألعابك المفضلة وقنواتك."
        ]
      ]
    }
  },
  "ja": {
    "tagline": "視聴は減らして、報酬は増やす。",
    "stories": {
      "queue": {
        "number": "01",
        "label": "自動ドロップ",
        "title": "あなたのドロップ。\nオートパイロットで。",
        "description": "大事なものを選ぶだけ。Lurkloot が配信を見つけ、進捗を追い、報酬を受け取ります。",
        "points": [
          "Twitch + Kick",
          "自動受け取り",
          "あなたのアカウント。あなたがコントロール。"
        ],
        "caption": "キュー、配信、次の報酬。すべてここに。"
      },
      "games": {
        "number": "02",
        "label": "視聴の優先順位",
        "title": "あなたのゲーム。\nあなたの優先度。",
        "description": "キャンペーンをピン留め。お気に入りゲームにスター。残りはブロック。次の報酬を本当に欲しいものに。",
        "points": [
          "個別キャンペーンをピン留め",
          "お気に入りゲームを先頭に",
          "プレイしないゲームをスキップ"
        ],
        "caption": "視聴時間を何に使うか決めよう。"
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "2つのプラットフォーム。\n1つのワークスペース。",
        "description": "Twitch と同じわかりやすい操作で Kick の報酬も把握できます。",
        "points": [
          "プラットフォーム別の操作",
          "ライブのキャンペーン進捗",
          "合間用のアイドル・ウォッチリスト"
        ],
        "caption": "プラットフォームを切り替えても、同じルーティン。"
      },
      "watchlist": {
        "number": "04",
        "label": "アイドル・ウォッチリスト",
        "title": "お気に入りを\n近くに。",
        "description": "対象ドロップがないときに視聴したいチャンネルを選びます。プラットフォームごとに別リストを持てます。",
        "points": [
          "あなたのチャンネル、あなたの順序",
          "プラットフォームあたり最大20チャンネル",
          "視聴ソースの優先度を設定"
        ],
        "caption": "キャンペーンとキャンペーンの間の計画。"
      },
      "extensions": {
        "number": "05",
        "label": "TWITCH 拡張機能",
        "title": "報酬を得る\nもう一つの方法。",
        "description": "Lurkloot は選ばれた Twitch 拡張機能の報酬にも対応します。必要なサポートを有効にし、視聴順序を設定します。",
        "points": [
          "オプションの Twitch 拡張機能サポート",
          "専用の進捗ビュー",
          "ソースを一か所で管理"
        ],
        "caption": "選ばれた拡張機能のサポート。有効化はあなた次第。"
      }
    },
    "overview": {
      "tagline": "報酬を、つなげる。",
      "title": "ドロップのその先。",
      "description": "対応 Twitch 拡張機能の報酬を、ドロップとアイドル・ウォッチリストと同じワークスペースに。",
      "steps": [
        [
          "オプションサポートを有効化",
          "有効にする対応拡張機能を選びます。"
        ],
        [
          "視聴順序を設定",
          "拡張機能報酬をドロップとウォッチリストのどこに置くか決めます。"
        ],
        [
          "進捗を確認",
          "専用ビューで報酬の進捗とステータスを確認します。"
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick。報酬は自動。",
        "選ばれた Twitch 拡張機能に対応。"
      ],
      "steps": [
        [
          "ドロップはオートパイロット",
          "配信を見つける。進捗を追う。報酬を受け取る。"
        ],
        [
          "Twitch 拡張機能も",
          "選ばれた拡張機能報酬のオプションサポート。"
        ],
        [
          "あなたの視聴順序",
          "キャンペーンをピン留め。ゲームにスター。チャンネルを選ぶ。"
        ]
      ]
    }
  },
  "id": {
    "tagline": "LEBIH SEDIKIT NONTON. LEBIH BANYAK HADIAH.",
    "stories": {
      "queue": {
        "number": "01",
        "label": "DROPS OTOMATIS",
        "title": "Drop Anda.\nOtomatis.",
        "description": "Pilih yang penting. Lurkloot mencari siaran, melacak progres, dan mengklaim hadiah Anda.",
        "points": [
          "Twitch + Kick",
          "Klaim otomatis",
          "Akun Anda. Kendali Anda."
        ],
        "caption": "Antrean, siaran, hadiah berikutnya. Semua di satu tempat."
      },
      "games": {
        "number": "02",
        "label": "URUTAN TONTON",
        "title": "Game Anda.\nPrioritas Anda.",
        "description": "Sematkan kampanye. Beri bintang game favorit. Blokir sisanya. Buat hadiah berikutnya yang benar-benar Anda inginkan.",
        "points": [
          "Sematkan kampanye individual",
          "Utamakan game favorit",
          "Lewati game yang tidak Anda mainkan"
        ],
        "caption": "Pilih apa yang mendapat waktu tonton Anda."
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "Dua platform.\nSatu tempat.",
        "description": "Pantau hadiah Kick dengan kontrol jelas yang sama seperti untuk Twitch.",
        "points": [
          "Kontrol terpisah per platform",
          "Progres kampanye live",
          "Idle watchlist untuk celah waktu"
        ],
        "caption": "Ganti platform. Rutinitas tetap sama."
      },
      "watchlist": {
        "number": "04",
        "label": "IDLE WATCHLIST",
        "title": "Favorit Anda\ntetap dekat.",
        "description": "Pilih saluran yang ingin ditonton saat tidak ada drop yang memenuhi syarat. Daftar terpisah untuk setiap platform.",
        "points": [
          "Saluran Anda, urutan Anda",
          "Hingga 20 saluran per platform",
          "Atur prioritas sumber tonton"
        ],
        "caption": "Rencana untuk waktu di antara kampanye."
      },
      "extensions": {
        "number": "05",
        "label": "EKSTENSI TWITCH",
        "title": "Lebih banyak\ncara dapat hadiah.",
        "description": "Lurkloot juga mendukung hadiah dari ekstensi Twitch tertentu. Aktifkan dukungan yang Anda mau dan atur urutan tonton.",
        "points": [
          "Dukungan ekstensi Twitch opsional",
          "Tampilan progres khusus",
          "Satu tempat kelola sumber Anda"
        ],
        "caption": "Dukungan ekstensi pilihan. Aktif sesuai keinginan Anda."
      }
    },
    "overview": {
      "tagline": "HADIAH, TERHUBUNG.",
      "title": "Di luar drop.",
      "description": "Gabungkan hadiah ekstensi Twitch yang didukung ke tempat yang sama dengan drop dan idle watchlist Anda.",
      "steps": [
        [
          "Aktifkan dukungan opsional",
          "Pilih ekstensi yang didukung untuk diaktifkan."
        ],
        [
          "Atur urutan tonton",
          "Tentukan posisi hadiah ekstensi bersama drop dan watchlist."
        ],
        [
          "Ikuti progres Anda",
          "Lihat progres dan status hadiah di tampilan khusus."
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Hadiah otomatis.",
        "Mendukung ekstensi Twitch pilihan."
      ],
      "steps": [
        [
          "Drop jalan otomatis",
          "Cari siaran. Lacak progres. Klaim hadiah."
        ],
        [
          "Ekstensi Twitch juga",
          "Dukungan opsional untuk hadiah ekstensi pilihan."
        ],
        [
          "Urutan tonton Anda",
          "Sematkan kampanye. Bintangi game. Pilih saluran."
        ]
      ]
    }
  },
  "pl": {
    "tagline": "MNIEJ OGLĄDANIA. WIĘCEJ NAGROD.",
    "stories": {
      "queue": {
        "number": "01",
        "label": "AUTO DROPY",
        "title": "Twoje dropy.\nNa autopilocie.",
        "description": "Wybierz, co dla Ciebie ważne. Lurkloot znajdzie stream, śledzi postęp i odbiera nagrody.",
        "points": [
          "Twitch + Kick",
          "Automatyczny odbiór",
          "Twoje konto. Twoja kontrola."
        ],
        "caption": "Kolejka, stream i kolejna nagroda. Wszystko w jednym miejscu."
      },
      "games": {
        "number": "02",
        "label": "KOLEJNOŚĆ",
        "title": "Twoje gry.\nTwoje priorytety.",
        "description": "Przypnij kampanię. Oznacz ulubioną grę gwiazdką. Zablokuj resztę. Niech kolejna nagroda będzie tą, którą naprawdę chcesz.",
        "points": [
          "Przypinaj pojedyncze kampanie",
          "Ulubione gry na początku",
          "Pomijaj gry, w które nie grasz"
        ],
        "caption": "Decyduj, co dostaje Twój czas oglądania."
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "Dwie platformy.\nJedno miejsce.",
        "description": "Śledź nagrody na Kick tymi samymi przejrzystymi ustawieniami, których używasz na Twitchu.",
        "points": [
          "Osobne ustawienia platform",
          "Postęp kampanii na żywo",
          "Listy bezczynne na przerwy"
        ],
        "caption": "Zmieniaj platformę. Trzymaj ten sam rytm."
      },
      "watchlist": {
        "number": "04",
        "label": "LISTA BEZCZYNNA",
        "title": "Ulubione kanały\nzawsze pod ręką.",
        "description": "Wybierz kanały do oglądania, gdy nie ma kwalifikujących się dropów. Osobna lista dla każdej platformy.",
        "points": [
          "Twoje kanały, w Twojej kolejności",
          "Do 20 kanałów na platformę",
          "Priorytet źródeł oglądania"
        ],
        "caption": "Plan na czas między kampaniami."
      },
      "extensions": {
        "number": "05",
        "label": "ROZSZERZENIA TWITCH",
        "title": "Więcej sposobów\nna nagrody.",
        "description": "Lurkloot obsługuje też nagrody z wybranych rozszerzeń Twitch. Włącz wsparcie, które chcesz, i ustaw kolejność oglądania.",
        "points": [
          "Opcjonalne rozszerzenia Twitch",
          "Osobne widoki postępu",
          "Jedno miejsce na źródła"
        ],
        "caption": "Wybrane rozszerzenia. Włączane na Twoich warunkach."
      }
    },
    "overview": {
      "tagline": "NAGRODY W JEDNYM MIEJSCU.",
      "title": "Poza dropami.",
      "description": "Wprowadź obsługiwane nagrody z rozszerzeń Twitch do tego samego miejsca co dropy i listy bezczynne.",
      "steps": [
        [
          "Włącz opcjonalne wsparcie",
          "Wybierz, które obsługiwane rozszerzenia włączyć."
        ],
        [
          "Ustaw kolejność oglądania",
          "Zdecyduj, gdzie nagrody z rozszerzeń stoją obok dropów i listy."
        ],
        [
          "Śledź postęp",
          "Postęp i status nagród w dedykowanych widokach."
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Automatyczne nagrody.",
        "Obsługa wybranych rozszerzeń Twitch."
      ],
      "steps": [
        [
          "Dropy na autopilocie",
          "Znajdź stream. Śledź postęp. Odbieraj nagrody."
        ],
        [
          "Też rozszerzenia Twitch",
          "Opcjonalne wsparcie dla wybranych nagród z rozszerzeń."
        ],
        [
          "Twoja kolejność",
          "Przypinaj kampanie. Oznaczaj gry. Wybieraj kanały."
        ]
      ]
    }
  },
  "ko": {
    "tagline": "시청은 줄이고, 보상은 늘리세요.",
    "stories": {
      "queue": {
        "number": "01",
        "label": "자동 드롭",
        "title": "내 드롭.\n자동으로.",
        "description": "중요한 것만 고르세요. Lurkloot가 스트림을 찾고, 진행 상황을 추적하며, 보상을 수령합니다.",
        "points": [
          "Twitch + Kick",
          "자동 수령",
          "내 계정. 내가 통제."
        ],
        "caption": "대기열, 스트림, 다음 보상. 한곳에서."
      },
      "games": {
        "number": "02",
        "label": "시청 순서",
        "title": "내 게임.\n내 우선순위.",
        "description": "캠페인을 고정하세요. 즐겨 찾는 게임에 별표를 달고, 나머지는 차단하세요. 다음 보상을 정말 원하는 것으로 만드세요.",
        "points": [
          "개별 캠페인 고정",
          "즐겨 찾는 게임을 먼저",
          "플레이하지 않는 게임 건너뛰기"
        ],
        "caption": "시청 시간을 어디에 쓸지 선택하세요."
      },
      "kick": {
        "number": "03",
        "label": "Twitch + Kick",
        "title": "두 플랫폼.\n하나의 작업 공간.",
        "description": "Twitch와 같은 명확한 조작으로 Kick 보상도 살펴보세요.",
        "points": [
          "플랫폼별 조작",
          "실시간 캠페인 진행",
          "공백 기간용 유휴 워치리스트"
        ],
        "caption": "플랫폼을 바꿔도 같은 루틴."
      },
      "watchlist": {
        "number": "04",
        "label": "유휴 워치리스트",
        "title": "즐겨 찾는 채널을\n가까이.",
        "description": "적격 드롭이 없을 때 시청할 채널을 선택하세요. 플랫폼마다 별도 목록을 유지할 수 있습니다.",
        "points": [
          "내 채널, 내 순서",
          "플랫폼당 최대 20개 채널",
          "시청 소스 우선순위 선택"
        ],
        "caption": "캠페인 사이 시간을 위한 계획."
      },
      "extensions": {
        "number": "05",
        "label": "Twitch 확장",
        "title": "더 많은\n획득 방법.",
        "description": "Lurkloot는 선택한 Twitch 확장 프로그램 보상도 지원합니다. 원하는 지원을 켜고 시청 순서를 설정하세요.",
        "points": [
          "선택적 Twitch 확장 지원",
          "전용 진행 화면",
          "소스를 한곳에서 관리"
        ],
        "caption": "선택한 확장 지원. 내 조건으로 활성화."
      }
    },
    "overview": {
      "tagline": "보상, 한곳에.",
      "title": "드롭 그 너머.",
      "description": "지원되는 Twitch 확장 보상을 드롭과 유휴 워치리스트와 같은 작업 공간으로 가져오세요.",
      "steps": [
        [
          "선택적 지원 켜기",
          "지원되는 확장 중 어떤 것을 켤지 선택하세요."
        ],
        [
          "시청 순서 설정",
          "확장 보상을 드롭과 워치리스트와 어떻게 배치할지 정하세요."
        ],
        [
          "진행 상황 확인",
          "전용 화면에서 보상 진행과 상태를 확인하세요."
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. 자동 보상.",
        "선택한 Twitch 확장 지원."
      ],
      "steps": [
        [
          "드롭 자동화",
          "스트림을 찾고, 진행을 추적하고, 보상을 수령하세요."
        ],
        [
          "Twitch 확장도",
          "선택한 확장 보상에 대한 선택적 지원."
        ],
        [
          "내 시청 순서",
          "캠페인 고정. 게임에 별표. 채널 선택."
        ]
      ]
    }
  },
  "uk": {
    "tagline": "МЕНШЕ ПЕРЕГЛЯДУ. БІЛЬШЕ НАГОРОД.",
    "stories": {
      "queue": {
        "number": "01",
        "label": "АВТОДРОПИ",
        "title": "Ваші дропи.\nНа автопілоті.",
        "description": "Оберіть, що важливо. Lurkloot знайде стрим, відстежить прогрес і забере нагороди.",
        "points": [
          "Twitch + Kick",
          "Автоматичний забір",
          "Ваш обліковий запис. Ваш контроль."
        ],
        "caption": "Черга, стрим і наступна нагорода. Все в одному місці."
      },
      "games": {
        "number": "02",
        "label": "ПОРЯДОК ПЕРЕГЛЯДУ",
        "title": "Ваші ігри.\nВаші пріоритети.",
        "description": "Закріпіть кампанію. Позначте улюблену гру. Заблокуйте решту. Наступна нагорода — та, яку ви справді хочете.",
        "points": [
          "Закріплюйте окремі кампанії",
          "Ставте улюблені ігри першими",
          "Пропускайте ігри, в які не граєте"
        ],
        "caption": "Оберіть, куди йде ваш час перегляду."
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "Дві платформи.\nОдин робочий простір.",
        "description": "Стежте за нагородами Kick із тими самими зрозумілими елементами керування, що й для Twitch.",
        "points": [
          "Окреме керування платформами",
          "Прогрес кампаній наживо",
          "Idle Watchlist між кампаніями"
        ],
        "caption": "Перемикайте платформи. Тримайте ту саму рутину."
      },
      "watchlist": {
        "number": "04",
        "label": "IDLE WATCHLIST",
        "title": "Тримайте\nулюблених поруч.",
        "description": "Оберіть канали для перегляду, коли немає доступних дропів. Окремий список для кожної платформи.",
        "points": [
          "Ваші канали у вашому порядку",
          "До 20 каналів на платформу",
          "Налаштуйте пріоритет джерел перегляду"
        ],
        "caption": "План на час між кампаніями."
      },
      "extensions": {
        "number": "05",
        "label": "РОЗШИРЕННЯ TWITCH",
        "title": "Більше способів\nотримувати.",
        "description": "Lurkloot також підтримує нагороди з обраних розширень Twitch. Увімкніть потрібну підтримку та задайте порядок перегляду.",
        "points": [
          "Необов’язкова підтримка розширень Twitch",
          "Окремі перегляди прогресу",
          "Одне місце для керування джерелами"
        ],
        "caption": "Підтримка обраних розширень. Увімкнення на ваших умовах."
      }
    },
    "overview": {
      "tagline": "НАГОРОДИ, ПОВ’ЯЗАНІ.",
      "title": "Поза дропами.",
      "description": "Об’єднайте підтримувані нагороди розширень Twitch із дропами та Idle Watchlist в одному робочому просторі.",
      "steps": [
        [
          "Увімкніть необов’язкову підтримку",
          "Оберіть, які підтримувані розширення увімкнути."
        ],
        [
          "Задайте порядок перегляду",
          "Вирішіть, де нагороди розширень стоять поруч із дропами та вашим списком."
        ],
        [
          "Стежте за прогресом",
          "Переглядайте прогрес і статус нагород у окремих переглядах."
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Автоматичні нагороди.",
        "Підтримка обраних розширень Twitch."
      ],
      "steps": [
        [
          "Дропи на автопілоті",
          "Знайти стрим. Відстежити прогрес. Забрати нагороди."
        ],
        [
          "Також розширення Twitch",
          "Необов’язкова підтримка нагород обраних розширень."
        ],
        [
          "Ваш порядок перегляду",
          "Закріплюйте кампанії. Позначайте ігри. Обирайте канали."
        ]
      ]
    }
  },
  "cs": {
    "tagline": "MÉNĚ SLEDOVÁNÍ. VÍCE ODMĚN.",
    "stories": {
      "queue": {
        "number": "01",
        "label": "AUTOMATICKÉ DROPS",
        "title": "Vaše drops.\nNa autopilotu.",
        "description": "Vyberte, na čem vám záleží. Lurkloot najde stream, sleduje váš postup a vyzvedne vaše odměny.",
        "points": [
          "Twitch + Kick",
          "Automatické vyzvedávání",
          "Váš účet. Vaše kontrola."
        ],
        "caption": "Fronta, stream a další odměna. Vše na jednom místě."
      },
      "games": {
        "number": "02",
        "label": "POŘADÍ SLEDOVÁNÍ",
        "title": "Vaše hry.\nVaše priority.",
        "description": "Připněte kampaň. Označte oblíbenou hru. Zablokujte zbytek. Ať je další odměna ta, kterou opravdu chcete.",
        "points": [
          "Připnout jednotlivé kampaně",
          "Oblíbené hry na první místo",
          "Přeskočit hry, které nehrajete"
        ],
        "caption": "Rozhodněte, co dostane váš čas sledování."
      },
      "kick": {
        "number": "03",
        "label": "TWITCH + KICK",
        "title": "Dvě platformy.\nJeden pracovní prostor.",
        "description": "Sledujte odměny na Kicku se stejně přehlednými ovládacími prvky jako na Twitchi.",
        "points": [
          "Samostatné ovládání platforem",
          "Průběh kampaní v reálném čase",
          "Idle watchlist pro mezery"
        ],
        "caption": "Přepněte platformu. Stejná rutina."
      },
      "watchlist": {
        "number": "04",
        "label": "IDLE WATCHLIST",
        "title": "Oblíbené\nnablízku.",
        "description": "Vyberte kanály, které chcete sledovat, když nejsou k dispozici žádné způsobilé drops. Pro každou platformu si udržujte vlastní seznam.",
        "points": [
          "Vaše kanály ve vašem pořadí",
          "Až 20 kanálů na platformu",
          "Nastavte prioritu zdroje sledování"
        ],
        "caption": "Plán na čas mezi kampaněmi."
      },
      "extensions": {
        "number": "05",
        "label": "TWITCH EXTENSIONS",
        "title": "Více cest\nk odměnám.",
        "description": "Lurkloot podporuje i odměny z vybraných Twitch rozšíření. Zapněte podporu, kterou chcete, a nastavte pořadí sledování.",
        "points": [
          "Volitelná podpora Twitch rozšíření",
          "Vyhrazené pohledy na postup",
          "Jedno místo pro správu zdrojů"
        ],
        "caption": "Podpora vybraných rozšíření. Zapnuté podle vašich pravidel."
      }
    },
    "overview": {
      "tagline": "ODMĚNY PROPOJENÉ.",
      "title": "Za hranicí drops.",
      "description": "Zintegrujte podporované odměny z Twitch rozšíření do stejného pracovního prostoru jako drops a idle watchlist.",
      "steps": [
        [
          "Zapněte volitelnou podporu",
          "Vyberte, která podporovaná rozšíření chcete povolit."
        ],
        [
          "Nastavte pořadí sledování",
          "Rozhodněte, kam ve frontě patří odměny z rozšíření vedle drops a watchlistu."
        ],
        [
          "Sledujte postup",
          "Průběh a stav odměn uvidíte ve vyhrazených pohledech."
        ]
      ]
    },
    "promo": {
      "lines": [
        "Twitch + Kick. Automatické odměny.",
        "Podporuje vybraná Twitch rozšíření."
      ],
      "steps": [
        [
          "Drops na autopilotu",
          "Najde stream. Sleduje postup. Vyzvedne odměny."
        ],
        [
          "I Twitch rozšíření",
          "Volitelná podpora odměn z vybraných rozšíření."
        ],
        [
          "Vaše pořadí sledování",
          "Připněte kampaně. Označte hry. Vyberte kanály."
        ]
      ]
    }
  }
};
