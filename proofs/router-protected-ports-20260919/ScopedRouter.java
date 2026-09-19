import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import com.google.gson.GsonBuilder;
import app.freerouting.Freerouting;
import app.freerouting.analytics.FRAnalytics;
import app.freerouting.autoroute.pipeline.BatchAutorouter;
import app.freerouting.board.facade.RoutingBoard;
import app.freerouting.board.model.structure.AngleRestriction;
import app.freerouting.core.*;
import app.freerouting.drc.DesignRulesChecker;
import app.freerouting.io.BoardReadResult;
import app.freerouting.io.specctra.*;
import app.freerouting.settings.*;
import app.freerouting.settings.sources.DefaultSettings;

/** Small local embedding adapter: no Freerouting.main, GUI, server, version check or job scheduler. */
public final class ScopedRouter {
  static List<Map<String,Object>> inspect(RoutingBoard b, Set<String> selected) {
    List<Map<String,Object>> rows=new ArrayList<>();
    var drc=new DesignRulesChecker(b,new DesignRulesCheckerSettings());
    Set<String> seen=new TreeSet<>();
    for(int i=1;i<=b.rules.nets.maxNetNumber();i++) {
      var n=b.rules.nets.get(i);if(n==null)continue;seen.add(n.name);
      boolean ignored=n.getNetClass().isIgnoredByAutorouter;
      if(ignored==selected.contains(n.name))throw new IllegalStateException("Incorrect ignored state: "+n.name);
      Map<String,Object> r=new LinkedHashMap<>();r.put("net",n.name);r.put("class",n.getNetClass().getName());r.put("ignored",ignored);
      r.put("items",n.getItems().size());r.put("vias",n.getViaCount());r.put("incompletes",drc.getIncompleteCount(i));rows.add(r);
    }
    if(!seen.containsAll(selected))throw new IllegalStateException("Unknown selected nets");return rows;
  }
  public static void main(String[] args) throws Exception {
    if(args.length!=5)throw new IllegalArgumentException("input.dsn output.ses audit.json selectedCommaNames seconds");
    Path in=Path.of(args[0]),out=Path.of(args[1]),audit=Path.of(args[2]);
    if(Files.exists(out)||Files.exists(audit))throw new IllegalStateException("Refusing stale/overwritten output");
    Set<String> selected=new TreeSet<>(Arrays.asList(args[3].split(",")));int seconds=Integer.parseInt(args[4]);
    if(seconds<1||seconds>60)throw new IllegalArgumentException("Bound outside1..60seconds");
    GlobalSettings.setUserDataPath(audit.toAbsolutePath().getParent().resolve("userdata"));
    Freerouting.globalSettings=new GlobalSettings();
    Freerouting.globalSettings.guiSettings.isEnabled=false;Freerouting.globalSettings.apiServerSettings.isEnabled=false;
    Freerouting.globalSettings.mcpServerSettings.isEnabled=false;Freerouting.globalSettings.usageAndDiagnosticData.disableAnalytics=true;
    FRAnalytics.setEnabled(false);
    BoardReadResult parsed=DsnReader.readBoard(Files.newInputStream(in),null,null,"scoped-local-input");
    if(!(parsed instanceof BoardReadResult.Success success))throw new IllegalStateException("DSN parse rejected: "+parsed);
    RoutingBoard board=(RoutingBoard)success.board();
    // Mark every class ignored, then enable only classes wholly composed of selected nets.
    for(int i=0;i<board.rules.netClasses.count();i++)board.rules.netClasses.get(i).isIgnoredByAutorouter=true;
    for(int i=1;i<=board.rules.nets.maxNetNumber();i++){var n=board.rules.nets.get(i);if(n!=null&&selected.contains(n.name))n.getNetClass().isIgnoredByAutorouter=false;}
    board.rules.setTraceAngleRestriction(AngleRestriction.FORTYFIVE_DEGREE);
    List<Map<String,Object>> before=inspect(board,selected);
    RouterSettings settings=new DefaultSettings().getSettings();settings.setLayerCount(board.getLayerCount());settings.applyBoardSpecificOptimizations(board);
    settings.enabled=true;settings.maxPasses=100;settings.maxThreads=1;settings.fanout.enabled=false;settings.optimizer.enabled=false;
    settings.automaticNeckdown=false;settings.neckWidthUm=0.0;settings.strictDrc=true;settings.jobTimeoutString=seconds+"s";
    RoutingJob job=new RoutingJob();job.board=board;job.routerSettings=settings;job.setInput(Files.readAllBytes(in));job.name="scoped-local-input";
    job.timeoutAt=Instant.now().plusSeconds(seconds);job.startedAt=Instant.now();job.state=RoutingJobState.RUNNING;
    final Throwable[] failure={null};
    StoppableThread worker=new StoppableThread(){protected void threadAction(){try{new BatchAutorouter(job).runBatchLoop();}catch(Throwable t){failure[0]=t;}}};
    job.thread=worker;worker.start();worker.join(seconds*1000L);
    boolean timedOut=worker.isAlive();if(timedOut){worker.requestStop();worker.requestStopAutoRouter();worker.join(5000);}
    if(worker.isAlive())throw new IllegalStateException("Router did not stop within bound");
    if(failure[0]!=null)throw new IllegalStateException("Router failed",failure[0]);
    RoutingBoard result=job.board;List<Map<String,Object>> after=inspect(result,selected);
    try(var os=Files.newOutputStream(out,StandardOpenOption.CREATE_NEW)){SesWriter.write(result,os,"scoped-local-input.dsn");}
    Map<String,Object> receipt=new LinkedHashMap<>();receipt.put("selected",selected);receipt.put("before",before);receipt.put("after",after);
    receipt.put("timedOut",timedOut);receipt.put("maxPasses",100);receipt.put("engine", "freerouting2.4.1-public-Java-API");
    receipt.put("limits","Scope flags are verified before/after; native import, geometry, dimensional and whole-model checks remain mandatory.");
    Files.writeString(audit,new GsonBuilder().setPrettyPrinting().create().toJson(receipt),StandardOpenOption.CREATE_NEW);
    System.out.println("SCOPED_ROUTER_FINISHED");
  }
}
