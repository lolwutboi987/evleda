// Prototype wrapper for pinned KiCad code. SPDX-License-Identifier: GPL-3.0-or-later
#include <cmath>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
#include <transline_calculations/microstrip.h>
#include <transline_calculations/coupled_microstrip.h>
#include <transline_calculations/stripline.h>
#include <transline_calculations/coupled_stripline.h>
using P=TRANSLINE_PARAMETERS;
static const char* names[]={"EPSILONR","TAND","RHO","H","H_T","T","PHYS_WIDTH","PHYS_DIAM_IN","PHYS_S","PHYS_DIAM_OUT","PHYS_LEN","ROUGH","MUR","MURC","FREQUENCY","STRIPLINE_A","TWISTEDPAIR_TWIST","TWISTEDPAIR_EPSILONR_ENV","Z0","Z0_E","Z0_O","ANG_L","DUMMY_PRM","SIGMA","SKIN_DEPTH","LOSS_DIELECTRIC","LOSS_CONDUCTOR","CUTOFF_FREQUENCY","EPSILON_EFF","EPSILON_EFF_EVEN","EPSILON_EFF_ODD","UNIT_PROP_DELAY","UNIT_PROP_DELAY_ODD","UNIT_PROP_DELAY_EVEN","ATTEN_COND","ATTEN_COND_EVEN","ATTEN_COND_ODD","ATTEN_DILECTRIC","ATTEN_DILECTRIC_EVEN","ATTEN_DILECTRIC_ODD","Z_DIFF"};
static std::string unit(const std::string& n){
 if(n=="FREQUENCY"||n=="CUTOFF_FREQUENCY") return "Hz";
 if(n=="SIGMA") return "S/m";
 if(n=="ANG_L") return "rad";
 if(n.rfind("Z0",0)==0||n=="Z_DIFF") return "ohm";
 if(n.rfind("UNIT_PROP_DELAY",0)==0) return "ps/cm";
 if(n.rfind("ATTEN_",0)==0||n.rfind("LOSS_",0)==0) return "dB";
 if(n=="H"||n=="H_T"||n=="T"||n=="PHYS_WIDTH"||n=="PHYS_S"||n=="PHYS_LEN"||n=="ROUGH"||n=="STRIPLINE_A"||n=="SKIN_DEPTH") return "m";
 return "1";
}
static void number(double v){if(std::isfinite(v))std::cout<<std::setprecision(17)<<v;else std::cout<<"null";}
int main(int argc,char** argv){try{
 std::string model,operation,fix; std::map<std::string,double> inputs; bool absentCover=false;
 for(int i=1;i<argc;++i){std::string s=argv[i]; if(s=="--model"||s=="--operation"||s=="--fix"){
  if(++i==argc)throw std::runtime_error("Missing option value");
  (s=="--model"?model:s=="--operation"?operation:fix)=argv[i];
 }else{auto p=s.find('=');if(p==std::string::npos)throw std::runtime_error("Expected NAME=value");
  auto key=s.substr(0,p);
  if(key=="H_T"&&s.substr(p+1)=="absent"){
   if(absentCover||inputs.count(key))throw std::runtime_error("Duplicate parameter");
   absentCover=true;continue;
  }
  if(key=="H_T"&&absentCover)throw std::runtime_error("Duplicate parameter");
  size_t used=0;double value=std::stod(s.substr(p+1),&used);
  if(used!=s.size()-p-1||!std::isfinite(value))throw std::runtime_error("Value must be finite numeric");
  if(!inputs.emplace(key,value).second)throw std::runtime_error("Duplicate parameter");}}
 bool coupled=model=="coupled_microstrip"||model=="coupled_stripline";
 bool micro=model=="microstrip"||model=="coupled_microstrip";
 std::unique_ptr<TRANSLINE_CALCULATION_BASE> c;
 if(model=="microstrip")c=std::make_unique<MICROSTRIP>();else if(model=="coupled_microstrip")c=std::make_unique<COUPLED_MICROSTRIP>();
 else if(model=="stripline")c=std::make_unique<STRIPLINE>();else if(model=="coupled_stripline")c=std::make_unique<COUPLED_STRIPLINE>();else throw std::runtime_error("Unsupported model");
 if(operation!="analyze"&&operation!="synthesize")throw std::runtime_error("Unsupported operation");
 if(absentCover&&model!="microstrip")throw std::runtime_error("Absent metallic cover is supported only for single microstrip");
 std::set<std::string> required={"EPSILONR","H","T","PHYS_WIDTH","PHYS_LEN","FREQUENCY","SIGMA","MURC"};
 if(coupled)required.insert("PHYS_S");
 if(micro){required.insert("H_T");required.insert("ROUGH");required.insert("TAND");}
 if(model=="microstrip")required.insert("MUR");
 if(model=="stripline"){required.insert("STRIPLINE_A");required.insert("TAND");}
 if(operation=="synthesize"){
  if(coupled){required.insert("Z0_O");if(fix!="width"&&fix!="spacing")throw std::runtime_error("Coupled synthesis requires --fix width or spacing");}
  else {required.insert("Z0");if(model=="microstrip")required.insert("ANG_L");}
 }else if(!fix.empty())throw std::runtime_error("--fix only applies to synthesis");
 for(const auto& n:required)if(!inputs.count(n)&&!(n=="H_T"&&absentCover))throw std::runtime_error("Missing required parameter: "+n);
 for(const auto& kv:inputs){
  if(!required.count(kv.first))throw std::runtime_error("Unsupported or output-only parameter: "+kv.first);
  if(kv.second<0||(kv.second==0&&kv.first!="TAND"&&kv.first!="ROUGH"&&kv.first!="PHYS_LEN"&&kv.first!="ANG_L"))throw std::runtime_error("Invalid parameter domain: "+kv.first);
  if(kv.first=="EPSILONR"&&kv.second<1)throw std::runtime_error("EPSILONR must be at least one");
  int index=0;while(index<41&&kv.first!=names[index])++index;if(index==41)throw std::runtime_error("Unknown parameter");
  c->SetParameter(static_cast<P>(index),kv.second);
 }
 if(absentCover){
  // MICROSTRIP::delta_q_cover(r)=tanh(1.043+0.121*r-1.164/r) -> 1 as r -> +infinity.
  // The explicit token stays in the protocol; this internal limit is never serialized as a number.
  // Coupled microstrip's separate cover fit is deliberately excluded above.
  static_assert(std::numeric_limits<double>::has_infinity,"Exact uncovered limit requires infinity");
  c->SetParameter(P::H_T,std::numeric_limits<double>::infinity());
 }
 if(!micro&&inputs.at("T")>=inputs.at("H"))throw std::runtime_error("Strip thickness must be smaller than plane separation");
 if(model=="stripline"&&inputs.at("STRIPLINE_A")+inputs.at("T")>=inputs.at("H"))throw std::runtime_error("Stripline upper offset plus thickness must be below plane separation");
 bool converged=true;
 if(operation=="synthesize")converged=c->Synthesize(fix=="width"?SYNTHESIZE_OPTS::FIX_WIDTH:fix=="spacing"?SYNTHESIZE_OPTS::FIX_SPACING:SYNTHESIZE_OPTS::DEFAULT);
 // Reanalysis is essential: native synthesis may restore requested impedance fields.
 c->Analyse();auto results=c->GetAnalysisResults();
 bool valid=converged;for(const auto& r:results)if(!std::isfinite(r.second.first)||r.second.second==TRANSLINE_STATUS::TS_ERROR)valid=false;
 if(operation=="synthesize"){
  auto target=coupled?P::Z0_O:P::Z0;double actual=c->GetParameter(target);
  if(!std::isfinite(actual)||std::abs(actual-inputs.at(coupled?"Z0_O":"Z0"))>1e-4)valid=false;
 }
 std::cout<<"{\"schemaVersion\":3,\"implementationRevision\":\"evleda-uncovered-microstrip-v1\",\"sourceCommit\":\"146a4f2a7585c65bc580427a19b6fe2ec4a3f622\",\"model\":\""<<model<<"\",\"operation\":\""<<operation<<"\",\"converged\":"<<(converged?"true":"false")<<",\"valid\":"<<(valid?"true":"false")<<",\"inputs\":{";
 bool first=true;for(const auto& kv:inputs){if(!first)std::cout<<',';first=false;std::cout<<'"'<<kv.first<<"\":{\"value\":";number(kv.second);std::cout<<",\"unit\":\""<<unit(kv.first)<<"\"}";}
 if(absentCover){if(!first)std::cout<<',';std::cout<<"\"H_T\":{\"value\":\"absent\",\"unit\":\"1\"}";}
 std::cout<<"},\"results\":{";first=true;
 std::map<int,std::pair<double,TRANSLINE_STATUS>> sorted;for(const auto& r:results)sorted[static_cast<int>(r.first)]=r.second;
 for(const auto& r:sorted){if(!first)std::cout<<',';first=false;const std::string n=names[r.first];std::cout<<'"'<<n<<"\":{\"value\":";number(r.second.first);std::cout<<",\"status\":\""<<(!std::isfinite(r.second.first)?"error":r.second.second==TRANSLINE_STATUS::OK?"ok":r.second.second==TRANSLINE_STATUS::WARNING?"warning":"error")<<"\",\"unit\":\""<<unit(n)<<"\"}";}
 std::cout<<"}}\n";return valid?0:2;
 }catch(const std::exception& e){std::cerr<<"Input/calculation error: "<<e.what()<<'\n';return 1;}}
