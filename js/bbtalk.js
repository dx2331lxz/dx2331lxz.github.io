let jsonUrl="https://ispeak.daoxuan.cc/api/ispeak?author=63e5b8c6dd7ad120f3690fa6";function bbtalk(){var e=JSON.parse(localStorage.getItem("bibi")),t=Date.now();let a;if(null==e||18e5<=t-e.time)getData();else{a=JSON.parse(e.ls);let l="";a.forEach((e,t)=>{e.content=e.content.replace(/[\s\uFEFF\xA0]+/g,"");var a=new Date(e.createdAt),a=a.getFullYear()+"/"+(a.getMonth()+1)+"/"+a.getDate()+" "+a.getHours()+":"+a.getMinutes()+":"+a.getSeconds(),a='<span class="datatime">'+timeago.format(a,"zh_CN")+"</span>";l+='<li class="item item-'+(t+1)+'">'+a+"： "+urlToLink(e.content)+"</li>"}),document.getElementById("bber-talk").innerHTML+='<i style="margin-right: 10px;" class="fa-regular fa-message"></i><ul class="talk-list">'+l+'</ul><i class="fa-solid fa-angles-right pass bber-icon"></i>'}}function getData(){fetch(jsonUrl).then(e=>e.json()).then(e=>{e={time:Date.now(),ls:JSON.stringify(e.data.items)},localStorage.setItem("bibi",JSON.stringify(e))}).then(()=>{bbtalk()}).catch(()=>{console.log("获取哔哔数据失败！")})}function urlToLink(e){return e=e.replace(/<img(.*?)src=[\"|\']?(.*?)[\"|\']?(.*?)>|!\[(.*?)\]\((.*?)\)/g,'<i class="fa-solid fa-image"></i>')}function Roll(){try{var e=Array.prototype.slice.call(document.querySelectorAll(".talk-list li")),a=e[0];e.splice(0,1),e.push(a);let t=document.querySelector("ul.talk-list");e.forEach(e=>{t.appendChild(e)})}catch(e){}}document.getElementById("bber-talk").addEventListener("click",()=>{window.location.pathname="/bb/"}),bbtalk(),setInterval(Roll,3e3);