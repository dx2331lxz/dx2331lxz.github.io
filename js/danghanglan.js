function page_title(){document.getElementById("page-title").style.display="/"===window.location.pathname||/^\/page\/[0-9]+\//.test(window.location.pathname),document.querySelector("#page-title>span").innerHTML=GLOBAL_CONFIG_SITE.title}window.onscroll=page_title;