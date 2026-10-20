import type { SupportedLocale } from "@lurkloot/shared/models";

// Store artwork copy is kept separate from product UI messages.
export interface StoreArtworkCopy {
  tagline: string;
  stories: {
    queue: StoreArtworkStory & { description: string };
    games: StoreArtworkStory;
    kick: StoreArtworkStory;
    watchlist: StoreArtworkStory & { description: string };
    free: StoreArtworkStory & { description: string };
  };
  // What Lurkloot supports on each platform, listed in the dual-platform shot.
  platforms: { twitch: string[]; kick: string[] };
  promo: { lines: string[]; steps: [string, string][] };
}

interface StoreArtworkStory {
  number: string;
  title: string;
}

export const STORE_ARTWORK_COPY: Record<SupportedLocale, StoreArtworkCopy> = {
  "en": {
    "tagline": "LESS WATCHING. MORE REWARDS.",
    "stories": {
      "queue": {
        "number": "01",
        "title": "Your drops.\nOn autopilot.",
        "description": "Pick what matters. Lurkloot finds a stream, tracks your progress, and claims your rewards."
      },
      "games": {
        "number": "02",
        "title": "Your games.\nYour priorities."
      },
      "kick": {
        "number": "03",
        "title": "Two platforms.\nOne workspace."
      },
      "watchlist": {
        "number": "04",
        "title": "Keep watching\nwhen there are no drops.",
        "description": "Your idle watchlist keeps you lurking in your favourite channels when Lurkloot has nothing to farm."
      },
      "free": {
        "number": "05",
        "title": "Always free.\nOpen source.",
        "description": "No ads. No subscriptions. Every line of code is on GitHub."
      }
    },
    "platforms": {
      "twitch": [
        "Drops",
        "Badges",
        "Idle watchlist",
        "Channel points",
        "Twitch extensions"
      ],
      "kick": [
        "Drops",
        "Badges",
        "Idle watchlist",
        "Daily reward",
        "Account level"
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
        "title": "Tus drops.\nEn automático.",
        "description": "Elige lo que te importa. Lurkloot busca una transmisión, sigue tu progreso y reclama tus recompensas."
      },
      "games": {
        "number": "02",
        "title": "Tus juegos.\nTus prioridades."
      },
      "kick": {
        "number": "03",
        "title": "Dos plataformas.\nUn solo lugar."
      },
      "watchlist": {
        "number": "04",
        "title": "Sigue viendo\ncuando no haya drops.",
        "description": "Tu lista de reserva te mantiene en tus canales favoritos cuando Lurkloot no tiene nada que farmear."
      },
      "free": {
        "number": "05",
        "title": "Siempre gratis.\nCódigo abierto.",
        "description": "Sin anuncios. Sin suscripciones. Cada línea de código está en GitHub."
      }
    },
    "platforms": {
      "twitch": [
        "Drops",
        "Insignias",
        "Lista de reserva",
        "Puntos de canal",
        "Extensiones de Twitch"
      ],
      "kick": [
        "Drops",
        "Insignias",
        "Lista de reserva",
        "Recompensa diaria",
        "Nivel de Kick"
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
        "title": "Vos drops.\nEn automatique.",
        "description": "Choisissez l’essentiel. Lurkloot trouve un stream, suit votre progression et récupère vos récompenses."
      },
      "games": {
        "number": "02",
        "title": "Vos jeux.\nVos priorités."
      },
      "kick": {
        "number": "03",
        "title": "Deux plateformes.\nUn seul espace."
      },
      "watchlist": {
        "number": "04",
        "title": "Continuez à regarder\nsans drops.",
        "description": "Votre liste de veille vous garde dans vos chaînes préférées quand Lurkloot n’a rien à farmer."
      },
      "free": {
        "number": "05",
        "title": "Toujours gratuit.\nCode ouvert.",
        "description": "Pas de pub. Pas d’abonnement. Chaque ligne de code est sur GitHub."
      }
    },
    "platforms": {
      "twitch": [
        "Drops",
        "Badges",
        "Liste de veille",
        "Points de chaîne",
        "Extensions Twitch"
      ],
      "kick": [
        "Drops",
        "Badges",
        "Liste de veille",
        "Récompense quotidienne",
        "Niveau Kick"
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
        "title": "I tuoi drop.\nIn automatico.",
        "description": "Scegli ciò che conta. Lurkloot trova uno stream, segue i progressi e riscatta le tue ricompense."
      },
      "games": {
        "number": "02",
        "title": "I tuoi giochi.\nLe tue priorità."
      },
      "kick": {
        "number": "03",
        "title": "Due piattaforme.\nUn unico spazio."
      },
      "watchlist": {
        "number": "04",
        "title": "Continua a guardare\nsenza drop.",
        "description": "La lista di riserva ti tiene nei tuoi canali preferiti quando Lurkloot non ha nulla da farmare."
      },
      "free": {
        "number": "05",
        "title": "Sempre gratuito.\nCodice aperto.",
        "description": "Niente pubblicità. Niente abbonamenti. Ogni riga di codice è su GitHub."
      }
    },
    "platforms": {
      "twitch": [
        "Drops",
        "Badge",
        "Lista di riserva",
        "Punti canale",
        "Estensioni Twitch"
      ],
      "kick": [
        "Drops",
        "Badge",
        "Lista di riserva",
        "Ricompensa giornaliera",
        "Livello Kick"
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
        "title": "Deine Drops.\nGanz automatisch.",
        "description": "Wähle, was dir wichtig ist. Lurkloot findet einen Stream, verfolgt den Fortschritt und holt deine Belohnungen ab."
      },
      "games": {
        "number": "02",
        "title": "Deine Spiele.\nDeine Prioritäten."
      },
      "kick": {
        "number": "03",
        "title": "Zwei Plattformen.\nEin Ort."
      },
      "watchlist": {
        "number": "04",
        "title": "Weiter schauen,\nauch ohne Drops.",
        "description": "Deine Leerlauf-Watchlist hält dich in deinen Lieblingskanälen, wenn Lurkloot nichts zu farmen hat."
      },
      "free": {
        "number": "05",
        "title": "Immer kostenlos.\nOpen Source.",
        "description": "Keine Werbung. Keine Abos. Jede Zeile Code ist auf GitHub."
      }
    },
    "platforms": {
      "twitch": [
        "Drops",
        "Abzeichen",
        "Leerlauf-Watchlist",
        "Kanalpunkte",
        "Twitch-Erweiterungen"
      ],
      "kick": [
        "Drops",
        "Abzeichen",
        "Leerlauf-Watchlist",
        "Tägliche Belohnung",
        "Kontolevel"
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
        "title": "Seus drops.\nNo automático.",
        "description": "Escolha o que importa. O Lurkloot encontra uma transmissão, acompanha o progresso e resgata suas recompensas."
      },
      "games": {
        "number": "02",
        "title": "Seus jogos.\nSuas prioridades."
      },
      "kick": {
        "number": "03",
        "title": "Duas plataformas.\nUm só lugar."
      },
      "watchlist": {
        "number": "04",
        "title": "Continue assistindo\nsem drops.",
        "description": "Sua lista de reserva mantém você nos seus canais favoritos quando o Lurkloot não tem nada para farmar."
      },
      "free": {
        "number": "05",
        "title": "Sempre gratuito.\nCódigo aberto.",
        "description": "Sem anúncios. Sem assinaturas. Cada linha de código está no GitHub."
      }
    },
    "platforms": {
      "twitch": [
        "Drops",
        "Emblemas",
        "Lista de reserva",
        "Pontos de canal",
        "Extensões da Twitch"
      ],
      "kick": [
        "Drops",
        "Emblemas",
        "Lista de reserva",
        "Recompensa diária",
        "Nível na Kick"
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
        "title": "Drop’ların.\nOtomatik pilotta.",
        "description": "Senin için önemli olanı seç. Lurkloot bir yayın bulur, ilerlemeyi takip eder ve ödüllerini alır."
      },
      "games": {
        "number": "02",
        "title": "Oyunların.\nÖnceliklerin."
      },
      "kick": {
        "number": "03",
        "title": "İki platform.\nTek alan."
      },
      "watchlist": {
        "number": "04",
        "title": "Drop olmadığında\nizlemeye devam et.",
        "description": "Lurkloot farmlayacak bir şey olmadığında Yedek Kanallar seni favori kanallarında tutar."
      },
      "free": {
        "number": "05",
        "title": "Her zaman ücretsiz.\nAçık kaynak.",
        "description": "Reklam yok. Abonelik yok. Her kod satırı GitHub’da."
      }
    },
    "platforms": {
      "twitch": [
        "Drop'lar",
        "Rozetler",
        "Yedek Kanallar",
        "Kanal puanları",
        "Twitch uzantıları"
      ],
      "kick": [
        "Drop'lar",
        "Rozetler",
        "Yedek Kanallar",
        "Günlük ödül",
        "Hesap seviyesi"
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
        "title": "Ваши дропы.\nНа автопилоте.",
        "description": "Выберите главное. Lurkloot найдёт трансляцию, отследит прогресс и заберёт награды."
      },
      "games": {
        "number": "02",
        "title": "Ваши игры.\nВаши приоритеты."
      },
      "kick": {
        "number": "03",
        "title": "Две платформы.\nОдно место."
      },
      "watchlist": {
        "number": "04",
        "title": "Продолжайте смотреть,\nкогда дропов нет.",
        "description": "Список просмотра в простое держит вас на любимых каналах, когда Lurkloot нечего фармить."
      },
      "free": {
        "number": "05",
        "title": "Всегда бесплатно.\nОткрытый код.",
        "description": "Без рекламы и подписок. Весь код открыт на GitHub."
      }
    },
    "platforms": {
      "twitch": [
        "Drops",
        "Значки",
        "Список просмотра",
        "Баллы канала",
        "Расширения Twitch"
      ],
      "kick": [
        "Drops",
        "Значки",
        "Список просмотра",
        "Ежедневная награда",
        "Уровень аккаунта"
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
        "title": "你的掉宝。\n自动搞定。",
        "description": "选择你在意的奖励。Lurkloot 会寻找直播、跟踪进度，并领取奖励。"
      },
      "games": {
        "number": "02",
        "title": "你的游戏。\n你的优先级。"
      },
      "kick": {
        "number": "03",
        "title": "两个平台。\n一个工作区。"
      },
      "watchlist": {
        "number": "04",
        "title": "没有掉宝时\n也要继续观看。",
        "description": "没有可挂机的掉宝时，空闲观看列表会让你继续留在喜爱的频道中。"
      },
      "free": {
        "number": "05",
        "title": "永久免费。\n开源项目。",
        "description": "无广告，无订阅，全部代码都在 GitHub 上。"
      }
    },
    "platforms": {
      "twitch": [
        "掉宝",
        "徽章",
        "空闲观看列表",
        "频道积分",
        "Twitch 扩展"
      ],
      "kick": [
        "掉宝",
        "徽章",
        "空闲观看列表",
        "每日奖励",
        "账户等级"
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
        "title": "आपके ड्रॉप्स।\nअपने-आप।",
        "description": "जो ज़रूरी है, उसे चुनें। Lurkloot स्ट्रीम ढूँढता है, प्रगति देखता है और आपके इनाम क्लेम करता है।"
      },
      "games": {
        "number": "02",
        "title": "आपके गेम।\nआपकी प्राथमिकताएँ।"
      },
      "kick": {
        "number": "03",
        "title": "दो प्लेटफ़ॉर्म।\nएक जगह।"
      },
      "watchlist": {
        "number": "04",
        "title": "ड्रॉप्स न हों तब भी\nदेखते रहें।",
        "description": "जब Lurkloot के पास फ़ार्म करने को कुछ न हो, तब निष्क्रिय वॉचलिस्ट आपको पसंदीदा चैनलों पर रखती है।"
      },
      "free": {
        "number": "05",
        "title": "हमेशा मुफ़्त।\nओपन सोर्स।",
        "description": "कोई विज्ञापन नहीं, कोई सब्सक्रिप्शन नहीं। पूरा कोड GitHub पर है।"
      }
    },
    "platforms": {
      "twitch": [
        "Drops",
        "बैज",
        "निष्क्रिय वॉचलिस्ट",
        "चैनल पॉइंट्स",
        "Twitch एक्सटेंशन"
      ],
      "kick": [
        "Drops",
        "बैज",
        "निष्क्रिय वॉचलिस्ट",
        "दैनिक इनाम",
        "अकाउंट लेवल"
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
        "title": "الدروب الخاصة بك.\nتلقائيًا.",
        "description": "اختر ما يهمك. يعثر Lurkloot على بث، ويتابع تقدمك، ويطالب بمكافآتك."
      },
      "games": {
        "number": "02",
        "title": "ألعابك.\nأولوياتك."
      },
      "kick": {
        "number": "03",
        "title": "منصتان.\nمساحة واحدة."
      },
      "watchlist": {
        "number": "04",
        "title": "استمر في المشاهدة\nحين لا توجد دروبس.",
        "description": "تُبقيك قائمة المشاهدة الخاملة في قنواتك المفضلة حين لا يكون لدى Lurkloot ما يفارمه."
      },
      "free": {
        "number": "05",
        "title": "مجاني دائمًا.\nمفتوح المصدر.",
        "description": "بلا إعلانات ولا اشتراكات. كل سطر من الكود متاح على GitHub."
      }
    },
    "platforms": {
      "twitch": [
        "Drops",
        "شارات",
        "المشاهدة الخاملة",
        "نقاط القناة",
        "إضافات Twitch"
      ],
      "kick": [
        "Drops",
        "شارات",
        "المشاهدة الخاملة",
        "المكافأة اليومية",
        "مستوى الحساب"
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
        "title": "あなたのドロップ。\nオートパイロットで。",
        "description": "大事なものを選ぶだけ。Lurkloot が配信を見つけ、進捗を追い、報酬を受け取ります。"
      },
      "games": {
        "number": "02",
        "title": "あなたのゲーム。\nあなたの優先度。"
      },
      "kick": {
        "number": "03",
        "title": "2つのプラットフォーム。\n1つのワークスペース。"
      },
      "watchlist": {
        "number": "04",
        "title": "ドロップが無くても、\n視聴は続く。",
        "description": "ファームするものがない時も、アイドル・ウォッチリストでお気に入りの配信に待機します。"
      },
      "free": {
        "number": "05",
        "title": "いつまでも無料。\nオープンソース。",
        "description": "広告なし、サブスクなし。コードはすべて GitHub で公開。"
      }
    },
    "platforms": {
      "twitch": [
        "Drops",
        "バッジ",
        "アイドル・ウォッチリスト",
        "チャンネルポイント",
        "Twitch 拡張機能"
      ],
      "kick": [
        "Drops",
        "バッジ",
        "アイドル・ウォッチリスト",
        "デイリー報酬",
        "アカウントレベル"
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
        "title": "Drop Anda.\nOtomatis.",
        "description": "Pilih yang penting. Lurkloot mencari siaran, melacak progres, dan mengklaim hadiah Anda."
      },
      "games": {
        "number": "02",
        "title": "Game Anda.\nPrioritas Anda."
      },
      "kick": {
        "number": "03",
        "title": "Dua platform.\nSatu tempat."
      },
      "watchlist": {
        "number": "04",
        "title": "Tetap menonton\nsaat tak ada drop.",
        "description": "Idle Watchlist membuat kamu tetap menonton saluran favorit saat tidak ada drop untuk di-farm."
      },
      "free": {
        "number": "05",
        "title": "Selalu gratis.\nOpen source.",
        "description": "Tanpa iklan. Tanpa langganan. Setiap baris kode ada di GitHub."
      }
    },
    "platforms": {
      "twitch": [
        "Drops",
        "Lencana",
        "Idle Watchlist",
        "Poin channel",
        "Ekstensi Twitch"
      ],
      "kick": [
        "Drops",
        "Lencana",
        "Idle Watchlist",
        "Hadiah harian",
        "Level akun"
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
        "title": "Twoje dropy.\nNa autopilocie.",
        "description": "Wybierz, co dla Ciebie ważne. Lurkloot znajdzie stream, śledzi postęp i odbiera nagrody."
      },
      "games": {
        "number": "02",
        "title": "Twoje gry.\nTwoje priorytety."
      },
      "kick": {
        "number": "03",
        "title": "Dwie platformy.\nJedno miejsce."
      },
      "watchlist": {
        "number": "04",
        "title": "Oglądaj dalej,\ngdy nie ma dropów.",
        "description": "Lista zapasowa trzyma Cię na ulubionych kanałach, gdy Lurkloot nie ma czego farmić."
      },
      "free": {
        "number": "05",
        "title": "Zawsze za darmo.\nOpen source.",
        "description": "Bez reklam. Bez subskrypcji. Każda linijka kodu jest na GitHubie."
      }
    },
    "platforms": {
      "twitch": [
        "Drops",
        "Odznaki",
        "Lista zapasowa",
        "Punkty kanału",
        "Rozszerzenia Twitch"
      ],
      "kick": [
        "Drops",
        "Odznaki",
        "Lista zapasowa",
        "Dzienna nagroda",
        "Poziom konta"
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
        "title": "내 드롭.\n자동으로.",
        "description": "중요한 것만 고르세요. Lurkloot가 스트림을 찾고, 진행 상황을 추적하며, 보상을 수령합니다."
      },
      "games": {
        "number": "02",
        "title": "내 게임.\n내 우선순위."
      },
      "kick": {
        "number": "03",
        "title": "두 플랫폼.\n하나의 작업 공간."
      },
      "watchlist": {
        "number": "04",
        "title": "드롭이 없어도\n계속 시청하세요.",
        "description": "파밍할 것이 없을 때도 대기 시청 목록으로 좋아하는 채널에 머물러요."
      },
      "free": {
        "number": "05",
        "title": "언제나 무료.\n오픈 소스.",
        "description": "광고 없음, 구독 없음. 모든 코드는 GitHub에 공개되어 있어요."
      }
    },
    "platforms": {
      "twitch": [
        "Drops",
        "배지",
        "대기 시청 목록",
        "채널 포인트",
        "Twitch 확장"
      ],
      "kick": [
        "Drops",
        "배지",
        "대기 시청 목록",
        "일일 보상",
        "계정 레벨"
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
        "title": "Ваші дропи.\nНа автопілоті.",
        "description": "Оберіть, що важливо. Lurkloot знайде стрим, відстежить прогрес і забере нагороди."
      },
      "games": {
        "number": "02",
        "title": "Ваші ігри.\nВаші пріоритети."
      },
      "kick": {
        "number": "03",
        "title": "Дві платформи.\nОдин робочий простір."
      },
      "watchlist": {
        "number": "04",
        "title": "Дивіться далі,\nколи дропів немає.",
        "description": "Idle Watchlist тримає вас на улюблених каналах, коли Lurkloot нема чого фармити."
      },
      "free": {
        "number": "05",
        "title": "Завжди безкоштовно.\nВідкритий код.",
        "description": "Без реклами та підписок. Увесь код доступний на GitHub."
      }
    },
    "platforms": {
      "twitch": [
        "Drops",
        "Значки",
        "Idle Watchlist",
        "Бали каналу",
        "Розширення Twitch"
      ],
      "kick": [
        "Drops",
        "Значки",
        "Idle Watchlist",
        "Щоденна нагорода",
        "Рівень акаунта"
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
        "title": "Vaše drops.\nNa autopilotu.",
        "description": "Vyberte, na čem vám záleží. Lurkloot najde stream, sleduje váš postup a vyzvedne vaše odměny."
      },
      "games": {
        "number": "02",
        "title": "Vaše hry.\nVaše priority."
      },
      "kick": {
        "number": "03",
        "title": "Dvě platformy.\nJeden pracovní prostor."
      },
      "watchlist": {
        "number": "04",
        "title": "Sledujte dál,\nkdyž nejsou drops.",
        "description": "Záložní seznam vás udrží na oblíbených kanálech, když Lurkloot nemá co farmit."
      },
      "free": {
        "number": "05",
        "title": "Vždy zdarma.\nOpen source.",
        "description": "Žádné reklamy. Žádná předplatná. Každý řádek kódu je na GitHubu."
      }
    },
    "platforms": {
      "twitch": [
        "Drops",
        "Odznaky",
        "Záložní seznam",
        "Channel points",
        "Rozšíření Twitch"
      ],
      "kick": [
        "Drops",
        "Odznaky",
        "Záložní seznam",
        "Denní odměna",
        "Úroveň účtu"
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
